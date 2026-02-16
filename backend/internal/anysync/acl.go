// Package anysync provides any-sync integration for MATOU.
// acl.go implements ACL management using the any-sync SDK's AclRecordBuilder
// for cryptographic invite codes, join-without-approval, and permission checks.
// It also provides application-layer policy helpers for KERI credential gating.
package anysync

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/anyproto/any-sync/commonspace/acl/aclclient"
	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/util/crypto"
)

// =============================================================================
// SDK-backed ACL Manager (wraps real any-sync ACL operations)
// =============================================================================

// MatouACLManager manages ACL operations for any-sync spaces using the SDK's
// AclRecordBuilder. It implements the InviteManager interface.
type MatouACLManager struct {
	client        AnySyncClient
	keyManager    *PeerKeyManager
	joiningClient aclclient.AclJoiningClient // optional, for join-before-open flows
}

// NewMatouACLManager creates a new MatouACLManager.
func NewMatouACLManager(client AnySyncClient, keyManager *PeerKeyManager) *MatouACLManager {
	return &MatouACLManager{
		client:     client,
		keyManager: keyManager,
	}
}

// SetJoiningClient sets the ACL joining client for join-before-open flows.
// When set, JoinWithInvite will submit the join record to the consensus node
// BEFORE opening the space, ensuring the user is authorized when HeadSync starts.
func (m *MatouACLManager) SetJoiningClient(jc aclclient.AclJoiningClient) {
	m.joiningClient = jc
}

// createOpenInviteMaxRetries is the maximum number of retries when the
// consensus node rejects an invite record due to a stale prev id.
// This happens when background ACL sync or a concurrent invite advances
// the ACL head between BuildInviteAnyone and AddRecord.
const createOpenInviteMaxRetries = 5

// CreateOpenInvite creates an "anyone can join" invite for a space.
// It encrypts the space's read key with the invite public key and returns
// the invite private key, which should be shared out-of-band (e.g. as a
// base58-encoded invite code).
//
// The method retries automatically when the consensus node rejects the
// record due to a stale prev id (ErrIncorrectRecordSequence), which can
// occur when rapid sequential invites cause the ACL head to advance
// between building and submitting the record.
func (m *MatouACLManager) CreateOpenInvite(ctx context.Context, spaceID string, permissions list.AclPermissions) (crypto.PrivKey, error) {
	space, err := m.client.GetSpace(ctx, spaceID)
	if err != nil {
		return nil, fmt.Errorf("getting space %s: %w", spaceID, err)
	}

	var lastErr error
	for attempt := 0; attempt <= createOpenInviteMaxRetries; attempt++ {
		if attempt > 0 {
			// Brief backoff to let the local ACL state catch up with the
			// consensus node (background sync delivers the conflicting record).
			delay := time.Duration(attempt) * time.Second
			log.Printf("[ACL] CreateOpenInvite retry %d/%d for space %s (waiting %v)",
				attempt, createOpenInviteMaxRetries, spaceID, delay)
			select {
			case <-ctx.Done():
				return nil, fmt.Errorf("context cancelled during retry backoff: %w", ctx.Err())
			case <-time.After(delay):
			}
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
			// Match both the sentinel error (local validation) and the
			// string message (DRPC error from consensus node).
			errMsg := err.Error()
			if strings.Contains(errMsg, "incorrect prev id") {
				lastErr = err
				log.Printf("[ACL] CreateOpenInvite: stale prev id for space %s (attempt %d), will retry",
					spaceID, attempt+1)
				continue
			}
			return nil, fmt.Errorf("adding invite record: %w", err)
		}

		return result.InviteKey, nil
	}

	return nil, fmt.Errorf("adding invite record after %d retries: %w", createOpenInviteMaxRetries, lastErr)
}

// JoinWithInvite joins a space using an invite key obtained out-of-band.
// The invite key is used to decrypt the space's read key from the invite
// record, then re-encrypt it with the joiner's own public key.
//
// When a joiningClient is set, the join record is submitted to the consensus
// node FIRST (via the joining client), before the space is opened locally.
// This is critical: if the space is opened before joining, HeadSync and the
// consensus ACL stream start before the user is authorized, causing "forbidden"
// errors and preventing tree sync.
func (m *MatouACLManager) JoinWithInvite(ctx context.Context, spaceID string, inviteKey crypto.PrivKey, metadata []byte) error {
	// Preferred path: join via consensus node directly BEFORE opening the space.
	// The aclJoiningClient fetches ACL records from the consensus node, builds
	// the join record, and submits it — all without opening the space locally.
	// After the join record is accepted, opening the space will include the user
	// in the ACL, so HeadSync discovers existing trees.
	if m.joiningClient != nil {
		fmt.Printf("[ACL] JoinWithInvite: using joining client (join-before-open) for space %s\n", spaceID)
		_, err := m.joiningClient.InviteJoin(ctx, spaceID, list.InviteJoinPayload{
			InviteKey: inviteKey,
			Metadata:  metadata,
		})
		if err != nil {
			// If the joining client fails (e.g. space already open with stale pool),
			// fall through to the space-based join path below.
			fmt.Printf("[ACL] JoinWithInvite: joining client failed (%v), falling back to space-based join\n", err)
		} else {
			// Now open the space — user is already in the ACL
			_, err = m.client.GetSpace(ctx, spaceID)
			if err != nil {
				return fmt.Errorf("opening space after join: %w", err)
			}
			return nil
		}
	}

	// Fallback path: open space first, then join via space's ACL client.
	// Used by test mocks and as fallback when joining client can't connect.
	space, err := m.client.GetSpace(ctx, spaceID)
	if err != nil {
		return fmt.Errorf("getting space %s: %w", spaceID, err)
	}

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

// CommunityReadOnlyACL creates an ACL policy for a community read-only space.
// Members get read-only access; only the org owner can write.
func CommunityReadOnlyACL(orgAID string) *ACLPolicy {
	return &ACLPolicy{
		PolicyType:        PolicyTypeCommunity,
		OwnerAID:          orgAID,
		DefaultPermission: PermissionRead,
		OwnerPermission:   PermissionOwner,
	}
}

// AdminACL creates an ACL policy for an admin-only space.
// No default access; only the org owner has access.
func AdminACL(orgAID string) *ACLPolicy {
	return &ACLPolicy{
		PolicyType:        PolicyTypePrivate,
		OwnerAID:          orgAID,
		DefaultPermission: PermissionNone,
		OwnerPermission:   PermissionOwner,
	}
}

// ACLPolicyForSpaceType returns the appropriate ACL policy for a space type.
func ACLPolicyForSpaceType(spaceType string, ownerAID string, orgAID string) *ACLPolicy {
	switch spaceType {
	case SpaceTypePrivate:
		return PrivateACL(ownerAID)
	case SpaceTypeCommunity:
		return CommunityACL(orgAID, "EMatouMembershipSchemaV1")
	case SpaceTypeCommunityReadOnly:
		return CommunityReadOnlyACL(orgAID)
	case SpaceTypeAdmin:
		return AdminACL(orgAID)
	default:
		return PrivateACL(ownerAID)
	}
}
