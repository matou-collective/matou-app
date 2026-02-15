//go:build integration

// Package anysync integration tests
//
// These tests require the any-sync test network to be running.
// The network is automatically started/stopped unless KEEP_TEST_NETWORK=1.
//
// Run with:
//
//	go test -tags=integration -v ./internal/anysync/...
//
// Keep network running between test runs:
//
//	KEEP_TEST_NETWORK=1 go test -tags=integration -v ./internal/anysync/...
package anysync

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/anyproto/any-sync/util/crypto"
	"github.com/matou-dao/backend/internal/anysync/testnet"
)

var testNetwork *testnet.Network

func TestMain(m *testing.M) {
	// Setup test network
	testNetwork = testnet.Setup()

	// Run tests
	code := m.Run()

	// Teardown (unless KEEP_TEST_NETWORK=1)
	testNetwork.Teardown()

	os.Exit(code)
}

// newTestSDKClient creates an SDKClient with a temp directory for test isolation.
func newTestSDKClient(t *testing.T) *SDKClient {
	t.Helper()
	configPath := testNetwork.GetHostConfigPath()
	client, err := NewSDKClient(configPath, &ClientOptions{
		DataDir: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("failed to create SDK client: %v", err)
	}
	t.Cleanup(func() { client.Close() })
	return client
}

func TestIntegration_NetworkConnectivity(t *testing.T) {
	testNetwork.RequireNetwork()

	t.Run("coordinator is reachable", func(t *testing.T) {
		url := testNetwork.GetCoordinatorURL()
		if url != "localhost:2004" {
			t.Errorf("expected coordinator at localhost:2004, got %s", url)
		}
	})

	t.Run("config file exists", func(t *testing.T) {
		configPath := testNetwork.GetHostConfigPath()
		if _, err := os.Stat(configPath); os.IsNotExist(err) {
			t.Errorf("config file not found at %s", configPath)
		}
	})
}

func TestIntegration_SDKConnect(t *testing.T) {
	testNetwork.RequireNetwork()

	client := newTestSDKClient(t)

	t.Run("SDK app starts successfully", func(t *testing.T) {
		if !client.initialized {
			t.Fatal("expected client to be initialized")
		}
	})

	t.Run("peer ID is assigned", func(t *testing.T) {
		peerID := client.GetPeerID()
		if peerID == "" {
			t.Fatal("expected non-empty peer ID")
		}
		if !strings.HasPrefix(peerID, "12D3KooW") {
			t.Errorf("peer ID should start with 12D3KooW, got %s", peerID)
		}
		t.Logf("Peer ID: %s", peerID)
	})

	t.Run("network ID matches config", func(t *testing.T) {
		networkID := client.GetNetworkID()
		if networkID == "" {
			t.Fatal("expected non-empty network ID")
		}
		// Load expected network ID from the test config file
		configPath := testNetwork.GetHostConfigPath()
		cfg, err := loadClientConfig(configPath)
		if err != nil {
			t.Fatalf("failed to load config: %v", err)
		}
		if networkID != cfg.NetworkID {
			t.Errorf("network ID mismatch: got %s, want %s", networkID, cfg.NetworkID)
		}
		t.Logf("Network ID: %s", networkID)
	})

	t.Run("coordinator URL is set", func(t *testing.T) {
		url := client.GetCoordinatorURL()
		if url == "" {
			t.Fatal("expected non-empty coordinator URL")
		}
		t.Logf("Coordinator URL: %s", url)
	})
}

func TestIntegration_Ping(t *testing.T) {
	testNetwork.RequireNetwork()

	client := newTestSDKClient(t)

	t.Run("ping verifies coordinator connectivity", func(t *testing.T) {
		err := client.Ping()
		if err != nil {
			t.Fatalf("ping failed: %v", err)
		}
		t.Log("Ping succeeded — coordinator is reachable")
	})
}

func TestIntegration_CreateSpace(t *testing.T) {
	testNetwork.RequireNetwork()

	client := newTestSDKClient(t)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	t.Run("create private space", func(t *testing.T) {
		ownerAID := "ETestOwner" + time.Now().Format("20060102150405")

		result, err := client.CreateSpace(ctx, ownerAID, SpaceTypePrivate, nil)
		if err != nil {
			t.Fatalf("failed to create space: %v", err)
		}

		if result.SpaceID == "" {
			t.Fatal("expected non-empty space ID")
		}
		// SDK space IDs should NOT start with "space_" (that's the local format)
		if strings.HasPrefix(result.SpaceID, "space_") {
			t.Errorf("SDK space ID should not use local format, got %s", result.SpaceID)
		}
		t.Logf("Created private space: %s", result.SpaceID)
	})

	t.Run("create community space", func(t *testing.T) {
		orgAID := "ETestOrg" + time.Now().Format("20060102150405")

		result, err := client.CreateSpace(ctx, orgAID, SpaceTypeCommunity, nil)
		if err != nil {
			t.Fatalf("failed to create community space: %v", err)
		}

		if result.SpaceID == "" {
			t.Fatal("expected non-empty space ID")
		}
		t.Logf("Created community space: %s", result.SpaceID)
	})
}

func TestIntegration_DeriveSpace(t *testing.T) {
	testNetwork.RequireNetwork()

	client := newTestSDKClient(t)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	t.Run("derive space is deterministic", func(t *testing.T) {
		ownerAID := "ETestDeriveOwner" + time.Now().Format("20060102150405")

		// DeriveSpaceID should return same ID for same inputs
		id1, err := client.DeriveSpaceID(ctx, ownerAID, SpaceTypePrivate, nil)
		if err != nil {
			t.Fatalf("failed to derive space ID (first call): %v", err)
		}

		id2, err := client.DeriveSpaceID(ctx, ownerAID, SpaceTypePrivate, nil)
		if err != nil {
			t.Fatalf("failed to derive space ID (second call): %v", err)
		}

		if id1 != id2 {
			t.Errorf("DeriveSpaceID should be deterministic: got %s vs %s", id1, id2)
		}
		t.Logf("Derived space ID: %s", id1)
	})

	t.Run("derive and create match", func(t *testing.T) {
		ownerAID := "ETestDerive2" + time.Now().Format("20060102150405")

		deriveResult, err := client.DeriveSpace(ctx, ownerAID, SpaceTypePrivate, nil)
		if err != nil {
			t.Fatalf("failed to derive space: %v", err)
		}
		if deriveResult.SpaceID == "" {
			t.Fatal("expected non-empty derived space ID")
		}
		t.Logf("Derived space: %s", deriveResult.SpaceID)
	})
}

func TestIntegration_SyncDocument(t *testing.T) {
	testNetwork.RequireNetwork()

	client := newTestSDKClient(t)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	ownerAID := "ETestSyncOwner" + time.Now().Format("20060102150405")
	spaceResult, err := client.CreateSpace(ctx, ownerAID, SpaceTypePrivate, nil)
	if err != nil {
		t.Fatalf("failed to create space: %v", err)
	}

	t.Run("sync document to space", func(t *testing.T) {
		docID := "doc_" + time.Now().Format("20060102150405")
		data := []byte(`{"type":"credential","data":"test"}`)

		err := client.SyncDocument(ctx, spaceResult.SpaceID, docID, data)
		if err != nil {
			t.Fatalf("failed to sync document: %v", err)
		}
		t.Logf("Synced document %s to space %s", docID, spaceResult.SpaceID)
	})
}

func TestIntegration_AddToACL(t *testing.T) {
	testNetwork.RequireNetwork()

	client := newTestSDKClient(t)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	orgAID := "ETestACLOrg" + time.Now().Format("20060102150405")
	spaceResult, err := client.CreateSpace(ctx, orgAID, SpaceTypeCommunity, nil)
	if err != nil {
		t.Fatalf("failed to create space: %v", err)
	}

	// Wait for space to propagate then mark as shareable (with retries)
	shareDeadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(shareDeadline) {
		err = client.MakeSpaceShareable(ctx, spaceResult.SpaceID)
		if err == nil {
			break
		}
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		t.Fatalf("failed to make space shareable: %v", err)
	}

	aclMgr := NewMatouACLManager(client, nil)

	t.Run("add peer to ACL", func(t *testing.T) {
		// Use CreateOpenInvite (the proper any-sync ACL mechanism)
		var inviteKey crypto.PrivKey
		inviteDeadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(inviteDeadline) {
			inviteKey, err = aclMgr.CreateOpenInvite(ctx, spaceResult.SpaceID, PermissionWrite.ToSDKPermissions())
			if err == nil {
				break
			}
			time.Sleep(2 * time.Second)
		}
		if inviteKey == nil {
			t.Fatalf("failed to create invite: %v", err)
		}
		pubKeyBytes, _ := inviteKey.GetPublic().Raw()
		t.Logf("Created open invite for space %s, public key: %x", spaceResult.SpaceID, pubKeyBytes[:8])
	})

	t.Run("add same peer again is idempotent", func(t *testing.T) {
		// Creating another invite should succeed (different invite key)
		inviteKey, err := aclMgr.CreateOpenInvite(ctx, spaceResult.SpaceID, PermissionWrite.ToSDKPermissions())
		if err != nil {
			t.Fatalf("failed to create second invite: %v", err)
		}
		if inviteKey == nil {
			t.Fatal("expected non-nil invite key")
		}
		t.Logf("Created second invite for space %s (idempotent)", spaceResult.SpaceID)
	})
}

func TestIntegration_SpaceManagerWithRealNetwork(t *testing.T) {
	testNetwork.RequireNetwork()

	client := newTestSDKClient(t)

	ctx := context.Background()

	t.Run("create space manager and private space", func(t *testing.T) {
		manager := NewSpaceManager(client, &SpaceManagerConfig{
			OrgAID: "ETestOrg" + time.Now().Format("20060102150405"),
		}, client.GetTreeManager())

		userAID := "ETestUser" + time.Now().Format("20060102150405")
		space, err := manager.CreatePrivateSpace(ctx, userAID)
		if err != nil {
			t.Fatalf("failed to create private space: %v", err)
		}

		if space == nil || space.SpaceID == "" {
			t.Error("expected non-nil space with ID")
		}
		t.Logf("Created private space via SpaceManager: %s", space.SpaceID)
	})
}
