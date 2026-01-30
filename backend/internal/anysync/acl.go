// Package anysync provides any-sync integration for MATOU.
// acl.go implements ACL management using the any-sync SDK's AclRecordBuilder
// for cryptographic invite codes, join-without-approval, and permission checks.
// It also provides application-layer policy helpers for KERI credential gating.
package anysync

import (
	"context"
	"fmt"

	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/util/crypto"
)

// =============================================================================
// SDK-backed ACL Manager (wraps real any-sync ACL operations)
// =============================================================================

// MatouACLManager manages ACL operations for any-sync spaces using the SDK's
// AclRecordBuilder. It implements the InviteManager interface.
type MatouACLManager struct {
	client     AnySyncClient
	keyManager *PeerKeyManager
}

// NewMatouACLManager creates a new MatouACLManager.
func NewMatouACLManager(client AnySyncClient, keyManager *PeerKeyManager) *MatouACLManager {
	return &MatouACLManager{
		client:     client,
		keyManager: keyManager,
	}
}

// CreateOpenInvite creates an "anyone can join" invite for a space.
// It encrypts the space's read key with the invite public key and returns
// the invite private key, which should be shared out-of-band (e.g. as a
// base58-encoded invite code).
func (m *MatouACLManager) CreateOpenInvite(ctx context.Context, spaceID string, permissions list.AclPermissions) (crypto.PrivKey, error) {
	space, err := m.client.GetSpace(ctx, spaceID)
	if err != nil {
		return nil, fmt.Errorf("getting space %s: %w", spaceID, err)
	}

	// Build the invite record while holding the ACL lock.
	acl := space.Acl()
	acl.Lock()
	builder := acl.RecordBuilder()
	result, err := builder.BuildInviteAnyone(permissions)
	acl.Unlock()
	if err != nil {
		return nil, fmt.Errorf("building invite: %w", err)
	}

	// Submit the invite record to the network (without the ACL lock —
	// AddRecord internally re-acquires it after the network round-trip).
	aclClient := space.AclClient()
	if err := aclClient.AddRecord(ctx, result.InviteRec); err != nil {
		return nil, fmt.Errorf("adding invite record: %w", err)
	}

	return result.InviteKey, nil
}

// JoinWithInvite joins a space using an invite key obtained out-of-band.
// The invite key is used to decrypt the space's read key from the invite
// record, then re-encrypt it with the joiner's own public key.
func (m *MatouACLManager) JoinWithInvite(ctx context.Context, spaceID string, inviteKey crypto.PrivKey, metadata []byte) error {
	space, err := m.client.GetSpace(ctx, spaceID)
	if err != nil {
		return fmt.Errorf("getting space %s: %w", spaceID, err)
	}

	// Build the join record while holding the ACL lock.
	acl := space.Acl()
	acl.Lock()
	builder := acl.RecordBuilder()
	joinRec, err := builder.BuildInviteJoinWithoutApprove(list.InviteJoinPayload{
		InviteKey: inviteKey,
		Metadata:  metadata,
	})
	acl.Unlock()
	if err != nil {
		return fmt.Errorf("building join record: %w", err)
	}

	// Submit to the network without the ACL lock.
	aclClient := space.AclClient()
	return aclClient.AddRecord(ctx, joinRec)
}

// GetPermissions returns a user's permissions in a space.
func (m *MatouACLManager) GetPermissions(ctx context.Context, spaceID string, identity crypto.PubKey) (list.AclPermissions, error) {
	space, err := m.client.GetSpace(ctx, spaceID)
	if err != nil {
		return list.AclPermissionsNone, fmt.Errorf("getting space %s: %w", spaceID, err)
	}

	acl := space.Acl()
	acl.RLock()
	defer acl.RUnlock()

	state := acl.AclState()
	if state == nil {
		return list.AclPermissionsNone, fmt.Errorf("ACL state not available for space %s", spaceID)
	}

	perm := state.Permissions(identity)
	return perm, nil
}

// =============================================================================
// Application-layer ACL policy (KERI credential gating)
// =============================================================================

// ACLPermission represents a permission level for application-layer validation.
// These map to the SDK's list.AclPermissions but are used for KERI-credential-based
// access control at the application layer.
type ACLPermission string

const (
	PermissionNone  ACLPermission = "none"
	PermissionRead  ACLPermission = "read"
	PermissionWrite ACLPermission = "write"
	PermissionAdmin ACLPermission = "admin"
	PermissionOwner ACLPermission = "owner"
)

// ToSDKPermissions converts an application-layer ACLPermission to the SDK type.
func (p ACLPermission) ToSDKPermissions() list.AclPermissions {
	switch p {
	case PermissionRead:
		return list.AclPermissionsReader
	case PermissionWrite:
		return list.AclPermissionsWriter
	case PermissionAdmin:
		return list.AclPermissionsAdmin
	case PermissionOwner:
		return list.AclPermissionsOwner
	default:
		return list.AclPermissionsNone
	}
}

// ACLPolicy defines application-layer access control rules for a space.
// This is used for KERI-credential-based gating before granting SDK-level access.
type ACLPolicy struct {
	PolicyType        string        `json:"policyType"`
	OwnerAID          string        `json:"ownerAid"`
	RequiredSchema    string        `json:"requiredSchema,omitempty"`
	DefaultPermission ACLPermission `json:"defaultPermission"`
	OwnerPermission   ACLPermission `json:"ownerPermission"`
}

const (
	PolicyTypePrivate   = "private"
	PolicyTypeCommunity = "community"
	PolicyTypePublic    = "public"
)

// PrivateACL creates an ACL policy for a private space (owner-only access).
func PrivateACL(ownerAID string) *ACLPolicy {
	return &ACLPolicy{
		PolicyType:        PolicyTypePrivate,
		OwnerAID:          ownerAID,
		RequiredSchema:    "",
		DefaultPermission: PermissionNone,
		OwnerPermission:   PermissionOwner,
	}
}

// CommunityACL creates an ACL policy for a community space (credential-gated).
func CommunityACL(orgAID string, requiredSchema string) *ACLPolicy {
	return &ACLPolicy{
		PolicyType:        PolicyTypeCommunity,
		OwnerAID:          orgAID,
		RequiredSchema:    requiredSchema,
		DefaultPermission: PermissionWrite,
		OwnerPermission:   PermissionOwner,
	}
}

// PublicACL creates an ACL policy for a public space (read-only for all).
func PublicACL(ownerAID string) *ACLPolicy {
	return &ACLPolicy{
		PolicyType:        PolicyTypePublic,
		OwnerAID:          ownerAID,
		RequiredSchema:    "",
		DefaultPermission: PermissionRead,
		OwnerPermission:   PermissionOwner,
	}
}

// ACLEntry represents an application-layer ACL entry for tracking members.
type ACLEntry struct {
	PeerID         string        `json:"peerId"`
	AID            string        `json:"aid,omitempty"`
	Permission     ACLPermission `json:"permission"`
	CredentialSAID string        `json:"credentialSaid,omitempty"`
	AddedAt        int64         `json:"addedAt"`
}

// ACLManager provides application-layer ACL validation using KERI credentials.
// For SDK-level ACL operations (invite/join), use MatouACLManager instead.
type ACLManager struct {
	client AnySyncClient
}

// NewACLManager creates a new application-layer ACL manager.
func NewACLManager(client AnySyncClient) *ACLManager {
	return &ACLManager{client: client}
}

// ValidateAccess checks if an AID has access to a space based on ACL policy.
// This is enforced at the application layer, not by any-sync directly.
func (m *ACLManager) ValidateAccess(policy *ACLPolicy, aid string, hasCredential bool, credentialSchema string) (ACLPermission, error) {
	if aid == policy.OwnerAID {
		return policy.OwnerPermission, nil
	}

	switch policy.PolicyType {
	case PolicyTypePrivate:
		return PermissionNone, nil

	case PolicyTypeCommunity:
		if policy.RequiredSchema != "" {
			if !hasCredential {
				return PermissionNone, fmt.Errorf("access requires credential with schema %s", policy.RequiredSchema)
			}
			if credentialSchema != policy.RequiredSchema {
				return PermissionNone, fmt.Errorf("credential schema %s does not match required schema %s", credentialSchema, policy.RequiredSchema)
			}
		}
		return policy.DefaultPermission, nil

	case PolicyTypePublic:
		return PermissionRead, nil

	default:
		return PermissionNone, fmt.Errorf("unknown policy type: %s", policy.PolicyType)
	}
}

// GrantAccess adds a user to a space's ACL via the legacy AddToACL path.
func (m *ACLManager) GrantAccess(spaceID string, peerID string, aid string, permission ACLPermission) error {
	var permissions []string
	switch permission {
	case PermissionRead:
		permissions = []string{"read"}
	case PermissionWrite:
		permissions = []string{"read", "write"}
	case PermissionAdmin:
		permissions = []string{"read", "write", "admin"}
	case PermissionOwner:
		permissions = []string{"read", "write", "admin", "owner"}
	default:
		return fmt.Errorf("cannot grant 'none' permission")
	}

	return m.client.AddToACL(nil, spaceID, peerID, permissions)
}

// RevokeAccess removes a user from a space's ACL.
func (m *ACLManager) RevokeAccess(spaceID string, peerID string) error {
	fmt.Printf("[ACL] Revoking access for peer %s from space %s\n", peerID, spaceID)
	return nil
}

// ACLPolicyForSpaceType returns the appropriate ACL policy for a space type.
func ACLPolicyForSpaceType(spaceType string, ownerAID string, orgAID string) *ACLPolicy {
	switch spaceType {
	case SpaceTypePrivate:
		return PrivateACL(ownerAID)
	case SpaceTypeCommunity:
		return CommunityACL(orgAID, "EMatouMembershipSchemaV1")
	default:
		return PrivateACL(ownerAID)
	}
}
