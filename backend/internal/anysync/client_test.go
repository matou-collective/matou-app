package anysync

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNewClient_ValidConfig(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "client_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Create a valid config file
	configPath := filepath.Join(tmpDir, "client.yml")
	configContent := `id: test-client
networkId: N4N6KzfYtNRNnC2LNDLjMtFik7846EPqLgi1PANKwpaAMGKF
nodes:
  - peerId: 12D3KooWTestCoordinator
    addresses:
      - localhost:1004
    types:
      - coordinator
  - peerId: 12D3KooWTestTreeNode
    addresses:
      - localhost:1001
    types:
      - tree
`
	if err := os.WriteFile(configPath, []byte(configContent), 0644); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	client, err := NewClient(configPath, &ClientOptions{
		DataDir:     tmpDir,
		PeerKeyPath: filepath.Join(tmpDir, "peer.key"),
	})
	if err != nil {
		t.Fatalf("failed to create client: %v", err)
	}
	defer client.Close()

	if !client.IsInitialized() {
		t.Error("expected client to be initialized")
	}
}

func TestNewClient_InvalidConfig(t *testing.T) {
	// Non-existent config file
	_, err := NewClient("/nonexistent/path/client.yml", nil)
	if err == nil {
		t.Error("expected error for non-existent config")
	}
}

func TestNewClient_MissingCoordinator(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "client_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Config without coordinator
	configPath := filepath.Join(tmpDir, "client.yml")
	configContent := `id: test-client
networkId: test-network
nodes:
  - peerId: 12D3KooWTestTreeNode
    addresses:
      - localhost:1001
    types:
      - tree
`
	if err := os.WriteFile(configPath, []byte(configContent), 0644); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	_, err = NewClient(configPath, &ClientOptions{
		DataDir: tmpDir,
	})
	if err == nil {
		t.Error("expected error for missing coordinator")
	}
}

func TestNewClient_WithMnemonic(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "client_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	configPath := createTestConfig(t, tmpDir)
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

	client, err := NewClient(configPath, &ClientOptions{
		DataDir:     tmpDir,
		PeerKeyPath: filepath.Join(tmpDir, "peer.key"),
		Mnemonic:    mnemonic,
	})
	if err != nil {
		t.Fatalf("failed to create client: %v", err)
	}
	defer client.Close()

	peerID := client.GetPeerID()
	if peerID == "" {
		t.Error("expected non-empty peer ID")
	}
}

func TestClient_CreateSpace_Private(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	ctx := context.Background()
	ownerAID := "EOwner1234567890abcdef"

	result, err := client.CreateSpace(ctx, ownerAID, SpaceTypePrivate, nil)
	if err != nil {
		t.Fatalf("failed to create space: %v", err)
	}

	if result.SpaceID == "" {
		t.Error("expected non-empty space ID")
	}

	if result.OwnerAID != ownerAID {
		t.Errorf("expected owner AID %s, got %s", ownerAID, result.OwnerAID)
	}

	if result.SpaceType != SpaceTypePrivate {
		t.Errorf("expected space type %s, got %s", SpaceTypePrivate, result.SpaceType)
	}

	if result.CreatedAt.IsZero() {
		t.Error("expected non-zero created time")
	}
}

func TestClient_CreateSpace_Community(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	ctx := context.Background()
	orgAID := "EOrg1234567890abcdef"

	result, err := client.CreateSpace(ctx, orgAID, SpaceTypeCommunity, nil)
	if err != nil {
		t.Fatalf("failed to create space: %v", err)
	}

	if result.SpaceType != SpaceTypeCommunity {
		t.Errorf("expected space type %s, got %s", SpaceTypeCommunity, result.SpaceType)
	}
}

func TestClient_CreateSpace_Idempotent(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	ctx := context.Background()
	ownerAID := "EOwner1234567890abcdef"

	// Create space twice
	result1, err := client.CreateSpace(ctx, ownerAID, SpaceTypePrivate, nil)
	if err != nil {
		t.Fatalf("first create failed: %v", err)
	}

	result2, err := client.CreateSpace(ctx, ownerAID, SpaceTypePrivate, nil)
	if err != nil {
		t.Fatalf("second create failed: %v", err)
	}

	// Should return the same space ID
	if result1.SpaceID != result2.SpaceID {
		t.Errorf("expected same space ID, got %s and %s", result1.SpaceID, result2.SpaceID)
	}
}

func TestClient_DeriveSpace(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	ctx := context.Background()
	ownerAID := "EOwner1234567890abcdef"

	result, err := client.DeriveSpace(ctx, ownerAID, SpaceTypePrivate, nil)
	if err != nil {
		t.Fatalf("failed to derive space: %v", err)
	}

	if result.SpaceID == "" {
		t.Error("expected non-empty space ID")
	}
}

func TestClient_DeriveSpaceID(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	ctx := context.Background()
	ownerAID := "EOwner1234567890abcdef"

	spaceID, err := client.DeriveSpaceID(ctx, ownerAID, SpaceTypePrivate, nil)
	if err != nil {
		t.Fatalf("failed to derive space ID: %v", err)
	}

	if spaceID == "" {
		t.Error("expected non-empty space ID")
	}

	// Derive again - should be deterministic
	spaceID2, err := client.DeriveSpaceID(ctx, ownerAID, SpaceTypePrivate, nil)
	if err != nil {
		t.Fatalf("failed to derive space ID again: %v", err)
	}

	if spaceID != spaceID2 {
		t.Errorf("expected same space ID, got %s and %s", spaceID, spaceID2)
	}
}

func TestClient_AddToACL(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	ctx := context.Background()
	spaceID := "space_test_123"
	peerID := "12D3KooWTest"
	permissions := []string{"read", "write"}

	// This is a no-op in local mode, but should not error
	err := client.AddToACL(ctx, spaceID, peerID, permissions)
	if err != nil {
		t.Fatalf("failed to add to ACL: %v", err)
	}
}

func TestClient_SyncDocument(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	ctx := context.Background()
	spaceID := "space_test_123"
	docID := "doc_123"
	data := []byte(`{"test": "data"}`)

	// This is a no-op in local mode, but should not error
	err := client.SyncDocument(ctx, spaceID, docID, data)
	if err != nil {
		t.Fatalf("failed to sync document: %v", err)
	}
}

func TestClient_GetNetworkID(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	networkID := client.GetNetworkID()
	if networkID == "" {
		t.Error("expected non-empty network ID")
	}
}

func TestClient_GetCoordinatorURL(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	url := client.GetCoordinatorURL()
	if url == "" {
		t.Error("expected non-empty coordinator URL")
	}
}

func TestClient_GetPeerID(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	peerID := client.GetPeerID()
	if peerID == "" {
		t.Error("expected non-empty peer ID")
	}
}

func TestClient_GetPeerInfo(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	info, err := client.GetPeerInfo()
	if err != nil {
		t.Fatalf("failed to get peer info: %v", err)
	}

	if info.PeerID == "" {
		t.Error("expected non-empty peer ID in info")
	}

	if info.PublicKey == "" {
		t.Error("expected non-empty public key in info")
	}
}

func TestClient_Ping(t *testing.T) {
	client, cleanup := setupTestClient(t)
	defer cleanup()

	err := client.Ping()
	if err != nil {
		t.Errorf("ping failed: %v", err)
	}
}

func TestClient_Close(t *testing.T) {
	client, tmpDir := setupTestClientWithDir(t)
	defer os.RemoveAll(tmpDir)

	err := client.Close()
	if err != nil {
		t.Fatalf("failed to close client: %v", err)
	}

	if client.IsInitialized() {
		t.Error("expected client to be not initialized after close")
	}
}

func TestClient_NotInitialized(t *testing.T) {
	client := &Client{initialized: false}

	ctx := context.Background()

	_, err := client.CreateSpace(ctx, "test", SpaceTypePrivate, nil)
	if err == nil {
		t.Error("expected error for uninitialized client")
	}

	_, err = client.DeriveSpaceID(ctx, "test", SpaceTypePrivate, nil)
	if err == nil {
		t.Error("expected error for uninitialized client")
	}

	err = client.AddToACL(ctx, "space", "peer", nil)
	if err == nil {
		t.Error("expected error for uninitialized client")
	}

	err = client.SyncDocument(ctx, "space", "doc", nil)
	if err == nil {
		t.Error("expected error for uninitialized client")
	}
}

func TestNewClientForTesting(t *testing.T) {
	coordinatorURL := "localhost:1004"
	networkID := "test-network"

	client := NewClientForTesting(coordinatorURL, networkID)

	if client.GetCoordinatorURL() != coordinatorURL {
		t.Errorf("expected coordinator URL %s, got %s", coordinatorURL, client.GetCoordinatorURL())
	}

	if client.GetNetworkID() != networkID {
		t.Errorf("expected network ID %s, got %s", networkID, client.GetNetworkID())
	}

	if !client.IsInitialized() {
		t.Error("expected client to be initialized")
	}
}

func TestGenerateSpaceID_Deterministic(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "client_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Create a peer key
	keyPath := filepath.Join(tmpDir, "peer.key")
	key, err := GetOrCreatePeerKey(keyPath)
	if err != nil {
		t.Fatalf("failed to create key: %v", err)
	}

	ownerAID := "EOwner1234567890abcdef"

	id1 := generateSpaceID(ownerAID, SpaceTypePrivate, key)
	id2 := generateSpaceID(ownerAID, SpaceTypePrivate, key)

	if id1 != id2 {
		t.Errorf("expected same space ID, got %s and %s", id1, id2)
	}

	// Different owner should produce different ID
	id3 := generateSpaceID("EOther123", SpaceTypePrivate, key)
	if id1 == id3 {
		t.Error("expected different space ID for different owner")
	}

	// Different type should produce different ID
	id4 := generateSpaceID(ownerAID, SpaceTypeCommunity, key)
	if id1 == id4 {
		t.Error("expected different space ID for different type")
	}
}

func TestLoadClientConfig(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "client_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	configPath := filepath.Join(tmpDir, "client.yml")
	configContent := `id: test-client
networkId: test-network-123
nodes:
  - peerId: peer-1
    addresses:
      - localhost:1001
    types:
      - coordinator
  - peerId: peer-2
    addresses:
      - localhost:1002
    types:
      - tree
`
	if err := os.WriteFile(configPath, []byte(configContent), 0644); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	config, err := loadClientConfig(configPath)
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}

	if config.ID != "test-client" {
		t.Errorf("expected ID test-client, got %s", config.ID)
	}

	if config.NetworkID != "test-network-123" {
		t.Errorf("expected network ID test-network-123, got %s", config.NetworkID)
	}

	if len(config.Nodes) != 2 {
		t.Errorf("expected 2 nodes, got %d", len(config.Nodes))
	}
}

func TestFindCoordinatorURL(t *testing.T) {
	nodes := []Node{
		{
			PeerID:    "peer-1",
			Addresses: []string{"localhost:1001"},
			Types:     []string{"tree"},
		},
		{
			PeerID:    "peer-2",
			Addresses: []string{"localhost:1004"},
			Types:     []string{"coordinator"},
		},
	}

	url := findCoordinatorURL(nodes)
	if url != "localhost:1004" {
		t.Errorf("expected localhost:1004, got %s", url)
	}
}

func TestFindCoordinatorURL_NotFound(t *testing.T) {
	nodes := []Node{
		{
			PeerID:    "peer-1",
			Addresses: []string{"localhost:1001"},
			Types:     []string{"tree"},
		},
	}

	url := findCoordinatorURL(nodes)
	if url != "" {
		t.Errorf("expected empty URL, got %s", url)
	}
}

func TestSpaceCreateResult(t *testing.T) {
	now := time.Now().UTC()

	result := SpaceCreateResult{
		SpaceID:   "space_123",
		CreatedAt: now,
		OwnerAID:  "EOwner123",
		SpaceType: SpaceTypePrivate,
	}

	if result.SpaceID != "space_123" {
		t.Errorf("unexpected space ID: %s", result.SpaceID)
	}

	if !result.CreatedAt.Equal(now) {
		t.Errorf("unexpected created time")
	}

	if result.OwnerAID != "EOwner123" {
		t.Errorf("unexpected owner AID: %s", result.OwnerAID)
	}

	if result.SpaceType != SpaceTypePrivate {
		t.Errorf("unexpected space type: %s", result.SpaceType)
	}
}

// Helper functions

func createTestConfig(t *testing.T, tmpDir string) string {
	t.Helper()

	configPath := filepath.Join(tmpDir, "client.yml")
	configContent := `id: test-client
networkId: N4N6KzfYtNRNnC2LNDLjMtFik7846EPqLgi1PANKwpaAMGKF
nodes:
  - peerId: 12D3KooWTestCoordinator
    addresses:
      - localhost:1004
    types:
      - coordinator
  - peerId: 12D3KooWTestTreeNode
    addresses:
      - localhost:1001
    types:
      - tree
`
	if err := os.WriteFile(configPath, []byte(configContent), 0644); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}
	return configPath
}

func setupTestClient(t *testing.T) (*Client, func()) {
	t.Helper()

	tmpDir, err := os.MkdirTemp("", "client_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	configPath := createTestConfig(t, tmpDir)

	client, err := NewClient(configPath, &ClientOptions{
		DataDir:     tmpDir,
		PeerKeyPath: filepath.Join(tmpDir, "peer.key"),
	})
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to create client: %v", err)
	}

	cleanup := func() {
		client.Close()
		os.RemoveAll(tmpDir)
	}

	return client, cleanup
}

func setupTestClientWithDir(t *testing.T) (*Client, string) {
	t.Helper()

	tmpDir, err := os.MkdirTemp("", "client_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	configPath := createTestConfig(t, tmpDir)

	client, err := NewClient(configPath, &ClientOptions{
		DataDir:     tmpDir,
		PeerKeyPath: filepath.Join(tmpDir, "peer.key"),
	})
	if err != nil {
		os.RemoveAll(tmpDir)
		t.Fatalf("failed to create client: %v", err)
	}

	return client, tmpDir
}
