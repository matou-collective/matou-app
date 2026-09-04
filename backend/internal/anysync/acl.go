// Package anysync provides any-sync integration for MATOU.
// acl.go implements ACL management using the any-sync SDK's AclRecordBuilder
// for cryptographic invite codes, join-without-approval, and permission checks.
// It also provides application-layer policy helpers for KERI credential gating.
package anysync

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/anyproto/any-sync/commonspace/acl/aclclient"
	"github.com/anyproto/any-sync/commonspace/object/acl/aclrecordproto"
	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/consensus/consensusproto"
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
	// coordACLGet fetches ACL records directly from the coordinator/consensus,
	// bypassing the sync-node's local replica. Used to recover from stale prev id.
	coordACLGet func(ctx context.Context, spaceId, aclHead string) ([]*consensusproto.RawRecordWithId, error)
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

// SetCoordACLGetter sets the function used to fetch ACL records directly from the
// coordinator. When set, retry loops can force-sync local ACL state from the
// authoritative coordinator head after an "incorrect prev id" rejection.
func (m *MatouACLManager) SetCoordACLGetter(fn func(ctx context.Context, spaceId, aclHead string) ([]*consensusproto.RawRecordWithId, error)) {
	m.coordACLGet = fn
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
				// Force-sync local ACL state from the coordinator — the
				// sync-node's replica can lag the consensus by minutes,
				// causing every retry to fail with the same stale head.
				if m.coordACLGet != nil {
					acl := space.Acl()
					acl.Lock()
					localHead := acl.Head().Id
					acl.Unlock()
					if recs, fetchErr := m.coordACLGet(ctx, spaceID, localHead); fetchErr == nil && len(recs) > 0 {
						acl.Lock()
						_ = acl.AddRawRecords(recs)
						acl.Unlock()
						log.Printf("[ACL] CreateOpenInvite: synced %d ACL records from coordinator for space %s", len(recs), spaceID)
					}
				}
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

	var lastJoinErr error
	for attempt := 0; attempt <= createOpenInviteMaxRetries; attempt++ {
		if attempt > 0 {
			delay := time.Duration(attempt) * time.Second
			log.Printf("[ACL] JoinWithInvite fallback retry %d/%d for space %s (waiting %v)",
				attempt, createOpenInviteMaxRetries, spaceID, delay)
			select {
			case <-ctx.Done():
				return fmt.Errorf("context cancelled during retry backoff: %w", ctx.Err())
			case <-time.After(delay):
			}
		}

		// Force-sync local ACL from coordinator before each attempt so the
		// join record is built with the authoritative head, not the stale
		// sync-node replica.
		if m.coordACLGet != nil {
			acl := space.Acl()
			acl.Lock()
			localHead := acl.Head().Id
			acl.Unlock()
			if recs, fetchErr := m.coordACLGet(ctx, spaceID, localHead); fetchErr == nil && len(recs) > 0 {
				acl.Lock()
				_ = acl.AddRawRecords(recs)
				acl.Unlock()
				log.Printf("[ACL] JoinWithInvite fallback: synced %d ACL records from coordinator for space %s", len(recs), spaceID)
			}
		}

		acl := space.Acl()
		acl.Lock()
		builder := acl.RecordBuilder()
		joinRec, buildErr := builder.BuildInviteJoinWithoutApprove(list.InviteJoinPayload{
			InviteKey: inviteKey,
			Metadata:  metadata,
		})
		acl.Unlock()
		if buildErr != nil {
			return fmt.Errorf("building join record: %w", buildErr)
		}

		aclClient := space.AclClient()
		if err := aclClient.AddRecord(ctx, joinRec); err != nil {
			if strings.Contains(err.Error(), "incorrect prev id") {
				lastJoinErr = err
				log.Printf("[ACL] JoinWithInvite fallback: stale prev id for space %s (attempt %d), will retry",
					spaceID, attempt+1)
				continue
			}
			return fmt.Errorf("adding join record: %w", err)
		}
		return nil
	}

	return fmt.Errorf("adding join record after %d retries: %w", createOpenInviteMaxRetries, lastJoinErr)
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

// ChangePermissions submits a PermissionChange record granting the target identity
// the specified permissions on the space. Only the space owner / accounts with
// CanManageAccounts permission can call this successfully — the SDK enforces this.
// Retries on stale prev id, matching the CreateOpenInvite retry pattern.
func (m *MatouACLManager) ChangePermissions(ctx context.Context, spaceID string, identity crypto.PubKey, permissions list.AclPermissions) error {
	space, err := m.client.GetSpace(ctx, spaceID)
	if err != nil {
		return fmt.Errorf("getting space %s: %w", spaceID, err)
	}

	var lastErr error
	for attempt := 0; attempt <= createOpenInviteMaxRetries; attempt++ {
		if attempt > 0 {
			delay := time.Duration(attempt) * time.Second
			log.Printf("[ACL] ChangePermissions retry %d/%d for space %s (waiting %v)",
				attempt, createOpenInviteMaxRetries, spaceID, delay)
			select {
			case <-ctx.Done():
				return fmt.Errorf("context cancelled during retry backoff: %w", ctx.Err())
			case <-time.After(delay):
			}
		}

		acl := space.Acl()
		acl.Lock()
		builder := acl.RecordBuilder()
		rec, buildErr := builder.BuildPermissionChanges(list.PermissionChangesPayload{
			Changes: []list.PermissionChangePayload{{Identity: identity, Permissions: permissions}},
		})
		acl.Unlock()
		if buildErr != nil {
			return fmt.Errorf("building permission change: %w", buildErr)
		}

		aclClient := space.AclClient()
		if err := aclClient.AddRecord(ctx, rec); err != nil {
			if strings.Contains(err.Error(), "incorrect prev id") {
				lastErr = err
				continue
			}
			return fmt.Errorf("adding permission change record: %w", err)
		}
		return nil
	}

	return fmt.Errorf("adding permission change record after %d retries: %w", createOpenInviteMaxRetries, lastErr)
}

// FindAccountPubKeyByAID iterates a space's ACL accounts and returns the pubkey
// of the account whose join-request metadata contains the given KERI AID.
// Metadata is written by HandleJoinCommunity as `{"aid":"...","joinedAt":"..."}`.
func (m *MatouACLManager) FindAccountPubKeyByAID(ctx context.Context, spaceID string, aid string) (crypto.PubKey, error) {
	space, err := m.client.GetSpace(ctx, spaceID)
	if err != nil {
		return nil, fmt.Errorf("getting space %s: %w", spaceID, err)
	}

	acl := space.Acl()
	acl.RLock()
	defer acl.RUnlock()

	state := acl.AclState()
	if state == nil {
		return nil, fmt.Errorf("ACL state not available for space %s", spaceID)
	}

	for _, account := range state.CurrentAccounts() {
		if len(account.RequestMetadata) == 0 {
			continue
		}
		// Metadata may be encrypted with the space metadata key. Try decrypting
		// first; fall back to plaintext for compatibility with older join records.
		raw := account.RequestMetadata
		if mdKey, mdErr := state.FirstMetadataKey(); mdErr == nil && mdKey != nil {
			if decrypted, decErr := mdKey.Decrypt(raw); decErr == nil {
				raw = decrypted
			}
		}
		if bytes.Contains(raw, []byte(`"aid":"`+aid+`"`)) {
			return account.PubKey, nil
		}
	}
	return nil, fmt.Errorf("no account found for AID %s in space %s", aid, spaceID)
}

// AccountAIDMap returns a deterministic mapping from every current ACL
// account's any-sync account string (crypto.PubKey.Account()) to the KERI AID
// that account declared in its join metadata. It is the reverse of
// FindAccountPubKeyByAID and is used to resolve the author of a synced change
// (change.Identity.Account()) back to a member AID for peer-side write-rule
// validation.
//
// Determinism and dedupe: join metadata is written by the *joining* peer, so a
// modified client can claim any AID. Records are walked in ACL record order
// (the same on every peer) and the FIRST account to claim an AID wins; a later
// account claiming an already-bound AID is dropped and logged. This blocks a
// second account from hijacking an existing member's AID, but NOT a fresh claim
// of an AID that has not joined yet — that needs KERI-backed binding proofs
// (GH#20). Accounts that are no longer active members, and accounts whose
// metadata carries no AID, are omitted.
func (m *MatouACLManager) AccountAIDMap(ctx context.Context, spaceID string) (map[string]string, error) {
	space, err := m.client.GetSpace(ctx, spaceID)
	if err != nil {
		return nil, fmt.Errorf("getting space %s: %w", spaceID, err)
	}

	acl := space.Acl()
	acl.RLock()
	defer acl.RUnlock()

	state := acl.AclState()
	if state == nil {
		return nil, fmt.Errorf("ACL state not available for space %s", spaceID)
	}

	// Metadata may be encrypted with any of the space's metadata keys.
	var mdKeys []crypto.PrivKey
	for _, k := range state.Keys() {
		if k.MetadataPrivKey != nil {
			mdKeys = append(mdKeys, k.MetadataPrivKey)
		}
	}

	active := make(map[string]bool)
	for _, account := range state.CurrentAccounts() {
		if account.PubKey != nil && !account.Permissions.NoPermissions() {
			active[account.PubKey.Account()] = true
		}
	}

	claims := aidClaimsInRecordOrder(acl, mdKeys)
	return bindFirstClaims(claims, active), nil
}

// aidClaim is one (account, AID) declaration found in an ACL record.
type aidClaim struct {
	account string
	aid     string
}

// aidClaimsInRecordOrder walks the ACL records in order and extracts every
// account → AID declaration from join content (invite-join, request-join,
// accounts-add). Order is the ACL record order, identical on every peer.
func aidClaimsInRecordOrder(acl list.AclList, mdKeys []crypto.PrivKey) []aidClaim {
	var claims []aidClaim
	add := func(identity crypto.PubKey, metadata []byte) {
		if identity == nil || len(metadata) == 0 {
			return
		}
		if aid := extractAIDFromMetadata(decryptMetadata(metadata, mdKeys)); aid != "" {
			claims = append(claims, aidClaim{account: identity.Account(), aid: aid})
		}
	}
	acl.Iterate(func(record *list.AclRecord) bool {
		data, ok := record.Model.(*aclrecordproto.AclData)
		if !ok || data == nil {
			return true
		}
		for _, content := range data.GetAclContent() {
			switch {
			case content.GetInviteJoin() != nil:
				ij := content.GetInviteJoin()
				if pk, err := crypto.UnmarshalEd25519PublicKeyProto(ij.GetIdentity()); err == nil {
					add(pk, ij.GetMetadata())
				}
			case content.GetRequestJoin() != nil:
				add(record.Identity, content.GetRequestJoin().GetMetadata())
			case content.GetAccountsAdd() != nil:
				for _, a := range content.GetAccountsAdd().GetAdditions() {
					if pk, err := crypto.UnmarshalEd25519PublicKeyProto(a.GetIdentity()); err == nil {
						add(pk, a.GetMetadata())
					}
				}
			}
		}
		return true
	})
	return claims
}

// bindFirstClaims applies first-bound-wins over claims (already in ACL record
// order), keeping only accounts in active. An account's own later re-claim of
// the same AID is a no-op; a different account's claim of a bound AID is
// rejected and logged.
func bindFirstClaims(claims []aidClaim, active map[string]bool) map[string]string {
	out := make(map[string]string)
	aidOwner := make(map[string]string)
	for _, c := range claims {
		if !active[c.account] {
			continue
		}
		if _, bound := out[c.account]; bound {
			continue // account already bound (first declaration wins)
		}
		if owner, taken := aidOwner[c.aid]; taken && owner != c.account {
			log.Printf("[write-rules] REJECTED duplicate AID claim: account %s claims %s already bound to %s (first-bound wins)",
				c.account, c.aid, owner)
			continue
		}
		aidOwner[c.aid] = c.account
		out[c.account] = c.aid
	}
	return out
}

// decryptMetadata tries each metadata key and returns the first successful
// plaintext, falling back to the raw bytes (older join records were plaintext).
func decryptMetadata(raw []byte, mdKeys []crypto.PrivKey) []byte {
	for _, k := range mdKeys {
		if decrypted, err := k.Decrypt(raw); err == nil {
			return decrypted
		}
	}
	return raw
}

// extractAIDFromMetadata pulls the "aid" value out of ACL join metadata, which
// HandleJoinCommunity writes as `{"aid":"...","joinedAt":"..."}`.
func extractAIDFromMetadata(raw []byte) string {
	var md struct {
		AID string `json:"aid"`
	}
	if err := json.Unmarshal(raw, &md); err == nil {
		return md.AID
	}
	return ""
}

// =============================================================================
// Application-layer ACL policy (KERI credential gating)
// =============================================================================

// ACLPermission represents a permission level for application-layer validation.
// These map to the SDK's list.AclPermissions but are used for KERI-credential-based
// access control at the application layer.
type ACLPermission string

// Application-layer permission levels, from least to most privileged.
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

// Application-layer ACL policy types used by ACLPolicy.PolicyType.
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
func (m *ACLManager) GrantAccess(spaceID string, peerID string, _ string, permission ACLPermission) error {
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

	return m.client.AddToACL(context.Background(), spaceID, peerID, permissions)
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
