package anysync

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadClientConfig(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "client_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

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

func TestLoadClientConfig_InvalidPath(t *testing.T) {
	_, err := loadClientConfig("/nonexistent/path/client.yml")
	if err == nil {
		t.Error("expected error for non-existent config")
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

func TestNodeTypesToProto(t *testing.T) {
	types := nodeTypesToProto([]string{"tree", "coordinator", "file", "consensus", "unknown"})
	if len(types) != 4 {
		t.Errorf("expected 4 recognized types, got %d", len(types))
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
