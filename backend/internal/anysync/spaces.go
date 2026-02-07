// Package anysync provides any-sync integration for MATOU.
// This file implements space management for private and community spaces.
package anysync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

// Space types
const (
	SpaceTypePrivate           = "private"
	SpaceTypeCommunity         = "community"
	SpaceTypeCommunityReadOnly = "community-readonly"
	SpaceTypeAdmin             = "admin"
)

// Space represents an any-sync space
type Space struct {
	SpaceID   string    `json:"spaceId"`
	OwnerAID  string    `json:"ownerAid"`
	SpaceType string    `json:"spaceType"`
	SpaceName string    `json:"spaceName"`
	CreatedAt time.Time `json:"createdAt"`
	LastSync  time.Time `json:"lastSync"`
}

// SpaceManager manages any-sync spaces for MATOU
type SpaceManager struct {
	client                   AnySyncClient
	aclManager               *MatouACLManager
	credTreeManager          *CredentialTreeManager
	objTreeManager           *ObjectTreeManager
	fileManager              *FileManager
	treeCache                *TreeCache
	communitySpaceID         string
	communityReadOnlySpaceID string
	adminSpaceID             string
	orgAID                   string
}

// SpaceManagerConfig holds configuration for SpaceManager
type SpaceManagerConfig struct {
	CommunitySpaceID         string
	CommunityReadOnlySpaceID string
	AdminSpaceID             string
	OrgAID                   string
}

// NewSpaceManager creates a new SpaceManager with shared TreeCache.
func NewSpaceManager(client AnySyncClient, cfg *SpaceManagerConfig) *SpaceManager {
	cache := NewTreeCache()
	objTreeMgr := NewObjectTreeManager(client, nil, cache)

	// Initialize FileManager if pool and nodeconf are available (real SDK client).
	// Mock clients return nil for GetPool/GetNodeConf, so FileManager is nil in tests.
	var fileMgr *FileManager
	if p := client.GetPool(); p != nil {
		if nc := client.GetNodeConf(); nc != nil {
			fileMgr = NewFileManager(p, nc, objTreeMgr)
		}
	}

	return &SpaceManager{
		client:                   client,
		aclManager:               NewMatouACLManager(client, nil),
		credTreeManager:          NewCredentialTreeManager(client, nil, cache),
		objTreeManager:           objTreeMgr,
		fileManager:              fileMgr,
		treeCache:                cache,
		communitySpaceID:         cfg.CommunitySpaceID,
		communityReadOnlySpaceID: cfg.CommunityReadOnlySpaceID,
		adminSpaceID:             cfg.AdminSpaceID,
		orgAID:                   cfg.OrgAID,
	}
}

// ACLManager returns the SDK-backed ACL manager for invite/join operations.
func (m *SpaceManager) ACLManager() *MatouACLManager {
	return m.aclManager
}

// CredentialTreeManager returns the credential tree manager.
func (m *SpaceManager) CredentialTreeManager() *CredentialTreeManager {
	return m.credTreeManager
}

// ObjectTreeManager returns the object tree manager.
func (m *SpaceManager) ObjectTreeManager() *ObjectTreeManager {
	return m.objTreeManager
}

// FileManager returns the file manager for filenode-based file storage.
// Returns nil if the client does not support pool/nodeconf (e.g. mock client).
func (m *SpaceManager) FileManager() *FileManager {
	return m.fileManager
}

// GetCommunityReadOnlySpaceID returns the community read-only space ID.
func (m *SpaceManager) GetCommunityReadOnlySpaceID() string {
	return m.communityReadOnlySpaceID
}

// SetCommunityReadOnlySpaceID sets the community read-only space ID.
func (m *SpaceManager) SetCommunityReadOnlySpaceID(spaceID string) {
	m.communityReadOnlySpaceID = spaceID
}

// GetAdminSpaceID returns the admin space ID.
func (m *SpaceManager) GetAdminSpaceID() string {
	return m.adminSpaceID
}

// SetAdminSpaceID sets the admin space ID.
func (m *SpaceManager) SetAdminSpaceID(spaceID string) {
	m.adminSpaceID = spaceID
}

// generatePrivateSpaceID generates a deterministic space ID for a user
// This ensures the same user always gets the same private space ID
func generatePrivateSpaceID(userAID string) string {
	hash := sha256.Sum256([]byte("matou-private:" + userAID))
	return "space-" + hex.EncodeToString(hash[:16])
}

// CreatePrivateSpace creates a user's private space in any-sync
func (m *SpaceManager) CreatePrivateSpace(ctx context.Context, userAID string) (*Space, error) {
	if userAID == "" {
		return nil, fmt.Errorf("user AID is required")
	}

	// Create space via any-sync client using the SDK
	result, err := m.client.CreateSpace(ctx, userAID, SpaceTypePrivate, nil)
	if err != nil {
		// Handle "space already exists" gracefully
		// The SDK returns the existing space ID in this case
		return nil, fmt.Errorf("creating space: %w", err)
	}

	// Truncate AID for display name (use shorter of 12 chars or full AID)
	displayAID := userAID
	if len(displayAID) > 12 {
		displayAID = displayAID[:12]
	}
	spaceName := fmt.Sprintf("Private Space - %s", displayAID)

	space := &Space{
		SpaceID:   result.SpaceID,
		OwnerAID:  userAID,
		SpaceType: SpaceTypePrivate,
		SpaceName: spaceName,
		CreatedAt: result.CreatedAt,
		LastSync:  result.CreatedAt,
	}

	return space, nil
}

// GetOrCreatePrivateSpace gets an existing private space or creates a new one
// The spaceStore parameter is used to check/store space records
func (m *SpaceManager) GetOrCreatePrivateSpace(ctx context.Context, userAID string, spaceStore SpaceStore) (*Space, error) {
	if userAID == "" {
		return nil, fmt.Errorf("user AID is required")
	}

	// Check if space exists in local store
	existingSpace, err := spaceStore.GetUserSpace(ctx, userAID)
	if err == nil && existingSpace != nil {
		return existingSpace, nil
	}

	// Create new space
	space, err := m.CreatePrivateSpace(ctx, userAID)
	if err != nil {
		return nil, fmt.Errorf("creating private space: %w", err)
	}

	// Save to local store
	if err := spaceStore.SaveSpace(ctx, space); err != nil {
		// Log error but don't fail - space was created in any-sync
		fmt.Printf("Warning: failed to save space record locally: %v\n", err)
	}

	return space, nil
}

// GetCommunitySpace returns the MATOU community space
func (m *SpaceManager) GetCommunitySpace(ctx context.Context) (*Space, error) {
	if m.communitySpaceID == "" {
		return nil, fmt.Errorf("community space ID not configured")
	}

	return &Space{
		SpaceID:   m.communitySpaceID,
		OwnerAID:  m.orgAID,
		SpaceType: SpaceTypeCommunity,
		SpaceName: "MATOU Community",
		// CreatedAt and LastSync would be fetched from any-sync in production
	}, nil
}

// GetCommunitySpaceID returns the community space ID
func (m *SpaceManager) GetCommunitySpaceID() string {
	return m.communitySpaceID
}

// GetClient returns the any-sync client
func (m *SpaceManager) GetClient() AnySyncClient {
	return m.client
}

// IsOrgAdmin returns true if the given AID is the configured org admin.
func (m *SpaceManager) IsOrgAdmin(aid string) bool {
	return m.orgAID != "" && m.orgAID == aid
}

// SetOrgAID sets the org AID at runtime (e.g. after HandleSetIdentity).
func (m *SpaceManager) SetOrgAID(orgAID string) {
	m.orgAID = orgAID
}

// SetCommunitySpaceID sets the community space ID
func (m *SpaceManager) SetCommunitySpaceID(spaceID string) {
	m.communitySpaceID = spaceID
}

// Credential represents a credential for routing purposes
type Credential struct {
	SAID      string `json:"said"`
	Issuer    string `json:"issuer"`
	Recipient string `json:"recipient"`
	Schema    string `json:"schema"`
	Data      any    `json:"data"`
}

// IsCommunityVisible determines if a credential should be visible in community space
// Membership and role credentials are community-visible
// Self-claims and invitations are private
func IsCommunityVisible(cred *Credential) bool {
	switch cred.Schema {
	case "EMatouMembershipSchemaV1":
		return true // Memberships are public
	case "EOperationsStewardSchemaV1":
		return true // Roles are public
	case "ESelfClaimSchemaV1":
		return false // Self-claims are private
	case "EInvitationSchemaV1":
		return false // Invitations are private
	default:
		return false
	}
}

// AddToCommunitySpace adds a credential to the community space.
// Uses CredentialTreeManager when available, falls back to SyncDocument.
func (m *SpaceManager) AddToCommunitySpace(ctx context.Context, cred *Credential) error {
	if !IsCommunityVisible(cred) {
		return fmt.Errorf("credential schema %s is not community-visible", cred.Schema)
	}

	if m.communitySpaceID == "" {
		return fmt.Errorf("community space ID not configured")
	}

	return m.addCredToSpace(ctx, m.communitySpaceID, cred)
}

// SyncToPrivateSpace syncs a credential to a user's private space.
// Uses CredentialTreeManager when available, falls back to SyncDocument.
func (m *SpaceManager) SyncToPrivateSpace(ctx context.Context, userAID string, cred *Credential, spaceStore SpaceStore) error {
	// Get or create the user's private space
	space, err := m.GetOrCreatePrivateSpace(ctx, userAID, spaceStore)
	if err != nil {
		return fmt.Errorf("getting private space: %w", err)
	}

	return m.addCredToSpace(ctx, space.SpaceID, cred)
}

// addCredToSpace adds a credential to a space using CredentialTreeManager if
// the space is available via GetSpace (SDK mode), otherwise falls back to SyncDocument.
func (m *SpaceManager) addCredToSpace(ctx context.Context, spaceID string, cred *Credential) error {
	// Try CredentialTreeManager path (requires real SDK space)
	if m.credTreeManager != nil {
		_, err := m.client.GetSpace(ctx, spaceID)
		if err == nil {
			// Space is available — use tree manager
			payload := &CredentialPayload{
				SAID:      cred.SAID,
				Issuer:    cred.Issuer,
				Recipient: cred.Recipient,
				Schema:    cred.Schema,
				Timestamp: time.Now().Unix(),
			}
			if cred.Data != nil {
				dataBytes, err := json.Marshal(cred.Data)
				if err == nil {
					payload.Data = dataBytes
				}
			}

			// Use the space's signing key if available
			keys, loadErr := LoadSpaceKeySet(m.client.GetDataDir(), spaceID)
			if loadErr == nil && keys.SigningKey != nil {
				_, addErr := m.credTreeManager.AddCredential(ctx, spaceID, payload, keys.SigningKey)
				return addErr
			}
		}
	}

	// Fallback: use SyncDocument
	data, err := json.Marshal(cred)
	if err != nil {
		return fmt.Errorf("marshaling credential: %w", err)
	}

	return m.client.SyncDocument(ctx, spaceID, cred.SAID, data)
}

// RouteCredential determines where a credential should be stored and syncs it.
// Credentials are ONLY synced to the recipient's private space. Community-visible
// data (CommunityProfile, SharedProfile) is written by the admin during approval
// via HandleInitMemberProfiles, which has proper ACL authorization.
func (m *SpaceManager) RouteCredential(ctx context.Context, cred *Credential, spaceStore SpaceStore) ([]string, error) {
	syncedSpaces := []string{}

	// Sync to recipient's private space only
	if cred.Recipient != "" {
		if err := m.SyncToPrivateSpace(ctx, cred.Recipient, cred, spaceStore); err != nil {
			return syncedSpaces, fmt.Errorf("syncing to private space: %w", err)
		}
		space, _ := spaceStore.GetUserSpace(ctx, cred.Recipient)
		if space != nil {
			syncedSpaces = append(syncedSpaces, space.SpaceID)
		}
	}

	// NOTE: Community-visible credentials are NOT written here. The admin backend
	// writes CommunityProfile and SharedProfile to community spaces during approval
	// (see HandleInitMemberProfiles in profiles.go). User backends don't have ACL
	// authorization to write to community spaces until they explicitly join.

	return syncedSpaces, nil
}

// SpaceStore interface for storing space records
// This is implemented by anystore.LocalStore
type SpaceStore interface {
	GetUserSpace(ctx context.Context, userAID string) (*Space, error)
	SaveSpace(ctx context.Context, space *Space) error
	ListAllSpaces(ctx context.Context) ([]*Space, error)
}
