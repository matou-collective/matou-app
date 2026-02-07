package anysync

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/anyproto/any-sync/commonspace"
	"github.com/anyproto/any-sync/net/pool"
	"github.com/anyproto/any-sync/nodeconf"
	"github.com/anyproto/any-sync/util/crypto"
)

// syncDocCall records a call to SyncDocument
type syncDocCall struct {
	SpaceID string
	DocID   string
	Data    []byte
}

// mockAnySyncClient implements AnySyncClient for testing
type mockAnySyncClient struct {
	spaces             map[string]*SpaceCreateResult
	createSpaceErr     error
	addToACLErr        error
	syncDocErr         error
	networkID          string
	coordinatorURL     string
	peerID             string
	syncDocumentCalls  []syncDocCall
}

func newMockAnySyncClient() *mockAnySyncClient {
	return &mockAnySyncClient{
		spaces:         make(map[string]*SpaceCreateResult),
		networkID:      "test-network",
		coordinatorURL: "localhost:1004",
		peerID:         "test-peer-123",
	}
}

func (m *mockAnySyncClient) CreateSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*SpaceCreateResult, error) {
	if m.createSpaceErr != nil {
		return nil, m.createSpaceErr
	}

	spaceID := fmt.Sprintf("space_%s_%s", spaceType, ownerAID[:8])
	if existing, ok := m.spaces[spaceID]; ok {
		return existing, nil
	}

	result := &SpaceCreateResult{
		SpaceID:   spaceID,
		CreatedAt: time.Now().UTC(),
		OwnerAID:  ownerAID,
		SpaceType: spaceType,
	}
	m.spaces[spaceID] = result
	return result, nil
}

func (m *mockAnySyncClient) DeriveSpace(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (*SpaceCreateResult, error) {
	return m.CreateSpace(ctx, ownerAID, spaceType, signingKey)
}

func (m *mockAnySyncClient) DeriveSpaceID(ctx context.Context, ownerAID string, spaceType string, signingKey crypto.PrivKey) (string, error) {
	return fmt.Sprintf("space_%s_%s", spaceType, ownerAID[:8]), nil
}

func (m *mockAnySyncClient) AddToACL(ctx context.Context, spaceID string, peerID string, permissions []string) error {
	return m.addToACLErr
}

func (m *mockAnySyncClient) SyncDocument(ctx context.Context, spaceID string, docID string, data []byte) error {
	m.syncDocumentCalls = append(m.syncDocumentCalls, syncDocCall{SpaceID: spaceID, DocID: docID, Data: data})
	return m.syncDocErr
}

func (m *mockAnySyncClient) MakeSpaceShareable(_ context.Context, _ string) error { return nil }
func (m *mockAnySyncClient) GetNetworkID() string      { return m.networkID }
func (m *mockAnySyncClient) GetCoordinatorURL() string { return m.coordinatorURL }
func (m *mockAnySyncClient) GetPeerID() string         { return m.peerID }
func (m *mockAnySyncClient) GetDataDir() string              { return "" }
func (m *mockAnySyncClient) GetSigningKey() crypto.PrivKey   { return nil }
func (m *mockAnySyncClient) GetPool() pool.Pool              { return nil }
func (m *mockAnySyncClient) GetNodeConf() nodeconf.Service   { return nil }
func (m *mockAnySyncClient) SetAccountFileLimits(ctx context.Context, identity string, limitBytes uint64) error {
	return nil
}
func (m *mockAnySyncClient) Ping() error { return nil }
func (m *mockAnySyncClient) Close() error                    { return nil }

func (m *mockAnySyncClient) CreateSpaceWithKeys(ctx context.Context, ownerAID string, spaceType string, keys *SpaceKeySet) (*SpaceCreateResult, error) {
	return m.CreateSpace(ctx, ownerAID, spaceType, nil)
}

func (m *mockAnySyncClient) GetSpace(ctx context.Context, spaceID string) (commonspace.Space, error) {
	return nil, fmt.Errorf("mock: GetSpace not supported")
}

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
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	ctx := context.Background()
	userAID := "EUSER123456789"

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
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	ctx := context.Background()

	_, err := manager.CreatePrivateSpace(ctx, "")
	if err == nil {
		t.Error("CreatePrivateSpace should fail with empty AID")
	}
}

func TestSpaceManager_CreatePrivateSpace_Idempotent(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	ctx := context.Background()
	userAID := "EUSER123456789"

	space1, err := manager.CreatePrivateSpace(ctx, userAID)
	if err != nil {
		t.Fatalf("first CreatePrivateSpace failed: %v", err)
	}

	space2, err := manager.CreatePrivateSpace(ctx, userAID)
	if err != nil {
		t.Fatalf("second CreatePrivateSpace failed: %v", err)
	}

	if space1.SpaceID != space2.SpaceID {
		t.Errorf("space IDs should match: %s != %s", space1.SpaceID, space2.SpaceID)
	}
}

func TestSpaceManager_GetCommunitySpace(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
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
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
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
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
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

	// Second call should return the same space (from store)
	space2, err := manager.GetOrCreatePrivateSpace(ctx, userAID, spaceStore)
	if err != nil {
		t.Fatalf("GetOrCreatePrivateSpace failed on second call: %v", err)
	}

	if space1.SpaceID != space2.SpaceID {
		t.Errorf("space IDs should match: %s != %s", space1.SpaceID, space2.SpaceID)
	}
}

func TestSpaceManager_GetOrCreatePrivateSpace_EmptyAID(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	spaceStore := newMockSpaceStore()
	ctx := context.Background()

	_, err := manager.GetOrCreatePrivateSpace(ctx, "", spaceStore)
	if err == nil {
		t.Error("GetOrCreatePrivateSpace should fail with empty AID")
	}
}

func TestSpaceManager_AddToCommunitySpace(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
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

func TestSpaceManager_AddToCommunitySpace_NoCommunityConfigured(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "",
		OrgAID:           "EORG123",
	})

	ctx := context.Background()

	membershipCred := &Credential{
		SAID:   "ESAID123",
		Schema: "EMatouMembershipSchemaV1",
	}

	err := manager.AddToCommunitySpace(ctx, membershipCred)
	if err == nil {
		t.Error("AddToCommunitySpace should fail when community space not configured")
	}
}

func TestSpaceManager_RouteCredential(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	spaceStore := newMockSpaceStore()
	ctx := context.Background()

	// All credentials are routed to private space only.
	// Community-visible data is written by admin via HandleInitMemberProfiles.
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

	if len(spaces) != 1 {
		t.Errorf("membership should be routed to 1 space (private only), got %d", len(spaces))
	}

	// Invitation credential should also be routed to private space only
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
		t.Errorf("invitation should be routed to 1 space (private only), got %d", len(spaces))
	}
}

func TestSpaceManager_RouteCredential_NoRecipient(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	spaceStore := newMockSpaceStore()
	ctx := context.Background()

	// Credential without recipient (e.g., self-claim)
	cred := &Credential{
		SAID:      "ESAID123",
		Issuer:    "EUSER123",
		Recipient: "",
		Schema:    "ESelfClaimSchemaV1",
	}

	spaces, err := manager.RouteCredential(ctx, cred, spaceStore)
	if err != nil {
		t.Fatalf("RouteCredential failed: %v", err)
	}

	if len(spaces) != 0 {
		t.Errorf("credential without recipient should be routed to 0 spaces, got %d", len(spaces))
	}
}

func TestSpaceManager_SyncToPrivateSpace(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	spaceStore := newMockSpaceStore()
	ctx := context.Background()
	userAID := "EUSER123456789"

	cred := &Credential{
		SAID:      "ESAID123",
		Issuer:    "EORG123",
		Recipient: userAID,
		Schema:    "EMatouMembershipSchemaV1",
	}

	err := manager.SyncToPrivateSpace(ctx, userAID, cred, spaceStore)
	if err != nil {
		t.Fatalf("SyncToPrivateSpace failed: %v", err)
	}

	// Verify space was created
	space, err := spaceStore.GetUserSpace(ctx, userAID)
	if err != nil || space == nil {
		t.Error("expected space to be created")
	}
}

func TestSpaceManager_SetCommunitySpaceID(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "",
		OrgAID:           "EORG123",
	})

	// Initially not configured
	if manager.GetCommunitySpaceID() != "" {
		t.Error("community space ID should initially be empty")
	}

	// Set community space ID
	manager.SetCommunitySpaceID("new-community-space")

	if manager.GetCommunitySpaceID() != "new-community-space" {
		t.Errorf("expected new-community-space, got %s", manager.GetCommunitySpaceID())
	}
}

func TestSpaceManager_GetClient(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	client := manager.GetClient()
	if client == nil {
		t.Error("expected non-nil client")
	}

	if client.GetNetworkID() != "test-network" {
		t.Errorf("expected test-network, got %s", client.GetNetworkID())
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

func TestCredential_Fields(t *testing.T) {
	cred := &Credential{
		SAID:      "ESAID123",
		Issuer:    "EISSUER",
		Recipient: "ERECIPIENT",
		Schema:    "EMatouMembershipSchemaV1",
		Data:      map[string]interface{}{"key": "value"},
	}

	if cred.SAID != "ESAID123" {
		t.Errorf("SAID mismatch")
	}
	if cred.Issuer != "EISSUER" {
		t.Errorf("Issuer mismatch")
	}
	if cred.Recipient != "ERECIPIENT" {
		t.Errorf("Recipient mismatch")
	}
	if cred.Schema != "EMatouMembershipSchemaV1" {
		t.Errorf("Schema mismatch")
	}
}

func TestSpaceManager_AddToCommunitySpace_CallsSyncDocument(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	ctx := context.Background()
	cred := &Credential{
		SAID:      "ESAID_MEMBERSHIP_001",
		Issuer:    "EORG123",
		Recipient: "EUSER456",
		Schema:    "EMatouMembershipSchemaV1",
		Data:      map[string]interface{}{"role": "Member"},
	}

	err := manager.AddToCommunitySpace(ctx, cred)
	if err != nil {
		t.Fatalf("AddToCommunitySpace failed: %v", err)
	}

	if len(mockClient.syncDocumentCalls) != 1 {
		t.Fatalf("expected 1 SyncDocument call, got %d", len(mockClient.syncDocumentCalls))
	}

	call := mockClient.syncDocumentCalls[0]
	if call.SpaceID != "community-space-123" {
		t.Errorf("expected spaceID community-space-123, got %s", call.SpaceID)
	}
	if call.DocID != "ESAID_MEMBERSHIP_001" {
		t.Errorf("expected docID ESAID_MEMBERSHIP_001, got %s", call.DocID)
	}
	if len(call.Data) == 0 {
		t.Error("expected non-empty data")
	}
}

func TestSpaceManager_SyncToPrivateSpace_CallsSyncDocument(t *testing.T) {
	mockClient := newMockAnySyncClient()
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{
		CommunitySpaceID: "community-space-123",
		OrgAID:           "EORG123",
	})

	spaceStore := newMockSpaceStore()
	ctx := context.Background()
	userAID := "EUSER123456789"

	cred := &Credential{
		SAID:      "ESAID_PRIVATE_001",
		Issuer:    "EORG123",
		Recipient: userAID,
		Schema:    "EMatouMembershipSchemaV1",
		Data:      map[string]interface{}{"role": "Member"},
	}

	err := manager.SyncToPrivateSpace(ctx, userAID, cred, spaceStore)
	if err != nil {
		t.Fatalf("SyncToPrivateSpace failed: %v", err)
	}

	if len(mockClient.syncDocumentCalls) != 1 {
		t.Fatalf("expected 1 SyncDocument call, got %d", len(mockClient.syncDocumentCalls))
	}

	call := mockClient.syncDocumentCalls[0]
	// The spaceID should be the private space that was created
	if call.SpaceID == "" {
		t.Error("expected non-empty spaceID")
	}
	if call.DocID != "ESAID_PRIVATE_001" {
		t.Errorf("expected docID ESAID_PRIVATE_001, got %s", call.DocID)
	}
	if len(call.Data) == 0 {
		t.Error("expected non-empty data")
	}
}

func TestSpaceManagerConfig(t *testing.T) {
	cfg := &SpaceManagerConfig{
		CommunitySpaceID: "community-123",
		OrgAID:           "EORG456",
	}

	if cfg.CommunitySpaceID != "community-123" {
		t.Errorf("CommunitySpaceID mismatch")
	}
	if cfg.OrgAID != "EORG456" {
		t.Errorf("OrgAID mismatch")
	}
}
