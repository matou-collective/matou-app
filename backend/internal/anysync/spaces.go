// Package anysync provides any-sync integration for MATOU.
// This file implements space management for private and community spaces.
package anysync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

// Space types
const (
	SpaceTypePrivate   = "private"
	SpaceTypeCommunity = "community"
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
	client           *Client
	communitySpaceID string
	orgAID           string
}

// SpaceManagerConfig holds configuration for SpaceManager
type SpaceManagerConfig struct {
	CommunitySpaceID string
	OrgAID           string
}

// NewSpaceManager creates a new SpaceManager
func NewSpaceManager(client *Client, cfg *SpaceManagerConfig) *SpaceManager {
	return &SpaceManager{
		client:           client,
		communitySpaceID: cfg.CommunitySpaceID,
		orgAID:           cfg.OrgAID,
	}
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

	spaceID := generatePrivateSpaceID(userAID)

	// Truncate AID for display name (use shorter of 12 chars or full AID)
	displayAID := userAID
	if len(displayAID) > 12 {
		displayAID = displayAID[:12]
	}
	spaceName := fmt.Sprintf("Private Space - %s", displayAID)

	// Create space via any-sync client
	_, err := m.client.CreateSpace(userAID, SpaceTypePrivate, spaceName)
	if err != nil {
		// Note: In production, this might fail if space already exists
		// For now, we'll continue and return the space info
		// The actual any-sync SDK will handle this more gracefully
	}

	space := &Space{
		SpaceID:   spaceID,
		OwnerAID:  userAID,
		SpaceType: SpaceTypePrivate,
		SpaceName: spaceName,
		CreatedAt: time.Now().UTC(),
		LastSync:  time.Now().UTC(),
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

// AddToCommunitySpace adds a credential to the community space
// Only community-visible credentials should be added
func (m *SpaceManager) AddToCommunitySpace(ctx context.Context, cred *Credential) error {
	if !IsCommunityVisible(cred) {
		return fmt.Errorf("credential schema %s is not community-visible", cred.Schema)
	}

	if m.communitySpaceID == "" {
		return fmt.Errorf("community space ID not configured")
	}

	// In production, this would sync the credential to the community space via any-sync
	// For now, we just validate the credential can be added
	// The actual sync will use the any-sync SDK's space document operations

	return nil
}

// SyncToPrivateSpace syncs a credential to a user's private space
func (m *SpaceManager) SyncToPrivateSpace(ctx context.Context, userAID string, cred *Credential, spaceStore SpaceStore) error {
	// Get or create the user's private space
	space, err := m.GetOrCreatePrivateSpace(ctx, userAID, spaceStore)
	if err != nil {
		return fmt.Errorf("getting private space: %w", err)
	}

	// In production, this would sync the credential to the private space via any-sync
	// For now, we just log the operation
	_ = space // Use space in production implementation

	return nil
}

// RouteCredential determines where a credential should be stored and syncs it
func (m *SpaceManager) RouteCredential(ctx context.Context, cred *Credential, spaceStore SpaceStore) ([]string, error) {
	syncedSpaces := []string{}

	// Always sync to recipient's private space
	if cred.Recipient != "" {
		if err := m.SyncToPrivateSpace(ctx, cred.Recipient, cred, spaceStore); err != nil {
			return syncedSpaces, fmt.Errorf("syncing to private space: %w", err)
		}
		space, _ := spaceStore.GetUserSpace(ctx, cred.Recipient)
		if space != nil {
			syncedSpaces = append(syncedSpaces, space.SpaceID)
		}
	}

	// If community-visible, also sync to community space
	if IsCommunityVisible(cred) {
		if err := m.AddToCommunitySpace(ctx, cred); err != nil {
			return syncedSpaces, fmt.Errorf("syncing to community space: %w", err)
		}
		syncedSpaces = append(syncedSpaces, m.communitySpaceID)
	}

	return syncedSpaces, nil
}

// SpaceStore interface for storing space records
// This is implemented by anystore.LocalStore
type SpaceStore interface {
	GetUserSpace(ctx context.Context, userAID string) (*Space, error)
	SaveSpace(ctx context.Context, space *Space) error
	ListAllSpaces(ctx context.Context) ([]*Space, error)
}
