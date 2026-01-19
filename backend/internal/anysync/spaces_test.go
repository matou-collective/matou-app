package anysync

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// mockSpaceStore implements SpaceStore for testing
type mockSpaceStore struct {
	spaces map[string]*Space
}

func newMockSpaceStore() *mockSpaceStore {
	return &mockSpaceStore{
		spaces: make(map[string]*Space),
	}
}

func (m *mockSpaceStore) GetUserSpace(ctx context.Context, userAID string) (*Space, error) {
	for _, space := range m.spaces {
		if space.OwnerAID == userAID && space.SpaceType == SpaceTypePrivate {
			return space, nil
		}
	}
	return nil, nil
}

func (m *mockSpaceStore) SaveSpace(ctx context.Context, space *Space) error {
	m.spaces[space.SpaceID] = space
	return nil
}

func (m *mockSpaceStore) ListAllSpaces(ctx context.Context) ([]*Space, error) {
	spaces := make([]*Space, 0, len(m.spaces))
	for _, space := range m.spaces {
		spaces = append(spaces, space)
	}
	return spaces, nil
}

// mockClient implements a minimal Client for testing
type mockClient struct {
	coordinatorURL string
	networkID      string
}

func TestGeneratePrivateSpaceID(t *testing.T) {
	// Test deterministic space ID generation
	userAID := "EAID123456789"

	id1 := generatePrivateSpaceID(userAID)
	id2 := generatePrivateSpaceID(userAID)

	if id1 != id2 {
		t.Errorf("space IDs should be deterministic: got %s and %s", id1, id2)
	}

	if id1[:6] != "space-" {
		t.Errorf("space ID should start with 'space-': got %s", id1)
	}

	// Different users should get different space IDs
	otherUserAID := "EAID987654321"
	id3 := generatePrivateSpaceID(otherUserAID)

	if id1 == id3 {
		t.Error("different users should have different space IDs")
	}
}

func TestIsCommunityVisible(t *testing.T) {
	tests := []struct {
		name     string
		schema   string
		expected bool
	}{
		{
			name:     "membership is community visible",
			schema:   "EMatouMembershipSchemaV1",
			expected: true,
		},
		{
			name:     "steward role is community visible",
			schema:   "EOperationsStewardSchemaV1",
			expected: true,
		},
		{
			name:     "self-claim is private",
			schema:   "ESelfClaimSchemaV1",
			expected: false,
		},
		{
			name:     "invitation is private",
			schema:   "EInvitationSchemaV1",
			expected: false,
		},
		{
			name:     "unknown schema is private",
			schema:   "EUnknownSchemaV1",
			expected: false,
		},
		{
			name:     "empty schema is private",
			schema:   "",
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cred := &Credential{Schema: tt.schema}
			result := IsCommunityVisible(cred)
			if result != tt.expected {
				t.Errorf("IsCommunityVisible(%s) = %v, want %v", tt.schema, result, tt.expected)
			}
		})
	}
}

func TestSpaceManager_CreatePrivateSpace(t *testing.T) {
	// Create a real client with httpClient initialized
	// Note: In production tests, we'd use a mock HTTP server
	client := &Client{
		coordinatorURL: "http://localhost:1004",
		networkID:      "test-network",
		httpClient:     &http.Client{}, // Initialize httpClient to avoid nil pointer
	}

	manager := NewSpaceManager(client, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	ctx := context.Background()
	userAID := "EUSER123456789"

	// CreatePrivateSpace will try HTTP call but continue on error
	// We're testing the space creation logic, not the HTTP call
	space, err := manager.CreatePrivateSpace(ctx, userAID)
	if err != nil {
		t.Fatalf("CreatePrivateSpace failed: %v", err)
	}

	if space.SpaceType != SpaceTypePrivate {
		t.Errorf("space type should be private, got %s", space.SpaceType)
	}

	if space.OwnerAID != userAID {
		t.Errorf("owner AID should be %s, got %s", userAID, space.OwnerAID)
	}

	if space.SpaceID == "" {
		t.Error("space ID should not be empty")
	}

	if space.CreatedAt.IsZero() {
		t.Error("created at should not be zero")
	}
}

func TestSpaceManager_CreatePrivateSpace_EmptyAID(t *testing.T) {
	client := &Client{
		coordinatorURL: "http://localhost:1004",
		networkID:      "test-network",
		httpClient:     &http.Client{},
	}

	manager := NewSpaceManager(client, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	ctx := context.Background()

	_, err := manager.CreatePrivateSpace(ctx, "")
	if err == nil {
		t.Error("CreatePrivateSpace should fail with empty AID")
	}
}

func TestSpaceManager_GetCommunitySpace(t *testing.T) {
	client := &Client{
		coordinatorURL: "http://localhost:1004",
		networkID:      "test-network",
		httpClient:     &http.Client{},
	}

	manager := NewSpaceManager(client, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	ctx := context.Background()

	space, err := manager.GetCommunitySpace(ctx)
	if err != nil {
		t.Fatalf("GetCommunitySpace failed: %v", err)
	}

	if space.SpaceID != "community-space-123" {
		t.Errorf("space ID should be community-space-123, got %s", space.SpaceID)
	}

	if space.SpaceType != SpaceTypeCommunity {
		t.Errorf("space type should be community, got %s", space.SpaceType)
	}

	if space.OwnerAID != "EORG123" {
		t.Errorf("owner AID should be EORG123, got %s", space.OwnerAID)
	}
}

func TestSpaceManager_GetCommunitySpace_NotConfigured(t *testing.T) {
	client := &Client{
		coordinatorURL: "http://localhost:1004",
		networkID:      "test-network",
		httpClient:     &http.Client{},
	}

	manager := NewSpaceManager(client, &SpaceManagerConfig{
		CommunitySpaceID: "",
		OrgAID:           "EORG123",
	})

	ctx := context.Background()

	_, err := manager.GetCommunitySpace(ctx)
	if err == nil {
		t.Error("GetCommunitySpace should fail when not configured")
	}
}

func TestSpaceManager_GetOrCreatePrivateSpace(t *testing.T) {
	client := &Client{
		coordinatorURL: "http://localhost:1004",
		networkID:      "test-network",
		httpClient:     &http.Client{},
	}

	manager := NewSpaceManager(client, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	spaceStore := newMockSpaceStore()
	ctx := context.Background()
	userAID := "EUSER123456789"

	// First call should create the space
	space1, err := manager.GetOrCreatePrivateSpace(ctx, userAID, spaceStore)
	if err != nil {
		t.Fatalf("GetOrCreatePrivateSpace failed: %v", err)
	}

	// Second call should return the same space
	space2, err := manager.GetOrCreatePrivateSpace(ctx, userAID, spaceStore)
	if err != nil {
		t.Fatalf("GetOrCreatePrivateSpace failed on second call: %v", err)
	}

	if space1.SpaceID != space2.SpaceID {
		t.Errorf("space IDs should match: %s != %s", space1.SpaceID, space2.SpaceID)
	}
}

func TestSpaceManager_AddToCommunitySpace(t *testing.T) {
	client := &Client{
		coordinatorURL: "http://localhost:1004",
		networkID:      "test-network",
		httpClient:     &http.Client{},
	}

	manager := NewSpaceManager(client, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	ctx := context.Background()

	// Membership credential should be allowed
	membershipCred := &Credential{
		SAID:   "ESAID123",
		Schema: "EMatouMembershipSchemaV1",
	}

	err := manager.AddToCommunitySpace(ctx, membershipCred)
	if err != nil {
		t.Errorf("AddToCommunitySpace should succeed for membership: %v", err)
	}

	// Invitation credential should be rejected
	invitationCred := &Credential{
		SAID:   "ESAID456",
		Schema: "EInvitationSchemaV1",
	}

	err = manager.AddToCommunitySpace(ctx, invitationCred)
	if err == nil {
		t.Error("AddToCommunitySpace should fail for invitation")
	}
}

func TestSpaceManager_RouteCredential(t *testing.T) {
	client := &Client{
		coordinatorURL: "http://localhost:1004",
		networkID:      "test-network",
		httpClient:     &http.Client{},
	}

	manager := NewSpaceManager(client, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	spaceStore := newMockSpaceStore()
	ctx := context.Background()

	// Membership credential should be routed to both private and community
	membershipCred := &Credential{
		SAID:      "ESAID123",
		Issuer:    "EORG123",
		Recipient: "EUSER456",
		Schema:    "EMatouMembershipSchemaV1",
	}

	spaces, err := manager.RouteCredential(ctx, membershipCred, spaceStore)
	if err != nil {
		t.Fatalf("RouteCredential failed: %v", err)
	}

	if len(spaces) != 2 {
		t.Errorf("membership should be routed to 2 spaces, got %d", len(spaces))
	}

	// Invitation credential should only be routed to private space
	invitationCred := &Credential{
		SAID:      "ESAID789",
		Issuer:    "EUSER123",
		Recipient: "EUSER456",
		Schema:    "EInvitationSchemaV1",
	}

	spaces, err = manager.RouteCredential(ctx, invitationCred, spaceStore)
	if err != nil {
		t.Fatalf("RouteCredential failed: %v", err)
	}

	if len(spaces) != 1 {
		t.Errorf("invitation should be routed to 1 space, got %d", len(spaces))
	}
}

func TestSpace_Fields(t *testing.T) {
	now := time.Now().UTC()
	space := &Space{
		SpaceID:   "space-123",
		OwnerAID:  "EAID456",
		SpaceType: SpaceTypePrivate,
		SpaceName: "Test Space",
		CreatedAt: now,
		LastSync:  now,
	}

	if space.SpaceID != "space-123" {
		t.Errorf("SpaceID mismatch")
	}
	if space.OwnerAID != "EAID456" {
		t.Errorf("OwnerAID mismatch")
	}
	if space.SpaceType != SpaceTypePrivate {
		t.Errorf("SpaceType mismatch")
	}
	if space.SpaceName != "Test Space" {
		t.Errorf("SpaceName mismatch")
	}
}
