//go:build integration

// P2P sync verification tests for any-sync integration.
//
// These tests verify that changes propagate between peers via HeadUpdate/FullSync.
// They require the any-sync test network to be running (Docker).
//
// Run with:
//
//	cd infrastructure/any-sync && docker compose --env-file .env.test up -d
//	go test -tags=integration ./internal/anysync/ -run "TestIntegration_P2PSync" -v -timeout 60s
package anysync

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestIntegration_P2PSync_CredentialTree(t *testing.T) {
	testNetwork.RequireNetwork()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client := newTestSDKClient(t)

	t.Run("create space with keys", func(t *testing.T) {
		keys, err := GenerateSpaceKeySet()
		if err != nil {
			t.Fatalf("generating keys: %v", err)
		}

		result, err := client.CreateSpaceWithKeys(ctx, "ETestSync_Owner", SpaceTypePrivate, keys)
		if err != nil {
			t.Fatalf("creating space: %v", err)
		}

		if result.SpaceID == "" {
			t.Fatal("expected non-empty space ID")
		}

		t.Logf("Created space: %s", result.SpaceID)
	})

	t.Run("create credential tree and add credential", func(t *testing.T) {
		keys, err := GenerateSpaceKeySet()
		if err != nil {
			t.Fatalf("generating keys: %v", err)
		}

		result, err := client.CreateSpaceWithKeys(ctx, "ETestSync_TreeOwner", SpaceTypePrivate, keys)
		if err != nil {
			t.Fatalf("creating space: %v", err)
		}

		treeMgr := NewCredentialTreeManager(client, nil)

		treeID, err := treeMgr.CreateCredentialTree(ctx, result.SpaceID, keys.SigningKey)
		if err != nil {
			t.Fatalf("creating credential tree: %v", err)
		}

		if treeID == "" {
			t.Fatal("expected non-empty tree ID")
		}
		t.Logf("Created tree: %s in space: %s", treeID, result.SpaceID)

		// Add a credential to the tree
		cred := &CredentialPayload{
			SAID:      "ESAID_sync_test_001",
			Issuer:    "ETestIssuer",
			Recipient: "ETestRecipient",
			Schema:    "EMatouMembershipSchemaV1",
			Data:      json.RawMessage(`{"role":"member","level":"basic"}`),
			Timestamp: time.Now().Unix(),
		}

		changeID, err := treeMgr.AddCredential(ctx, result.SpaceID, cred, keys.SigningKey)
		if err != nil {
			t.Fatalf("adding credential: %v", err)
		}

		if changeID == "" {
			t.Fatal("expected non-empty change ID")
		}
		t.Logf("Added credential, change ID: %s", changeID)

		// Read back credentials
		creds, err := treeMgr.ReadCredentials(ctx, result.SpaceID)
		if err != nil {
			t.Fatalf("reading credentials: %v", err)
		}

		// Expect at least 1 credential (the one we added)
		found := false
		for _, c := range creds {
			if c.SAID == "ESAID_sync_test_001" {
				found = true
				if c.Issuer != "ETestIssuer" {
					t.Errorf("issuer mismatch: got %s, want ETestIssuer", c.Issuer)
				}
				if c.Schema != "EMatouMembershipSchemaV1" {
					t.Errorf("schema mismatch: got %s", c.Schema)
				}
			}
		}
		if !found {
			t.Errorf("credential ESAID_sync_test_001 not found in tree (got %d credentials)", len(creds))
		}
	})
}

func TestIntegration_P2PSync_ACLInvite(t *testing.T) {
	testNetwork.RequireNetwork()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client := newTestSDKClient(t)

	keys, err := GenerateSpaceKeySet()
	if err != nil {
		t.Fatalf("generating keys: %v", err)
	}

	result, err := client.CreateSpaceWithKeys(ctx, "ETestACL_Owner", SpaceTypeCommunity, keys)
	if err != nil {
		t.Fatalf("creating space: %v", err)
	}

	t.Logf("Created community space: %s", result.SpaceID)

	aclMgr := NewMatouACLManager(client, nil)

	t.Run("create open invite", func(t *testing.T) {
		inviteKey, err := aclMgr.CreateOpenInvite(ctx, result.SpaceID, PermissionWrite.ToSDKPermissions())
		if err != nil {
			t.Fatalf("creating invite: %v", err)
		}

		if inviteKey == nil {
			t.Fatal("expected non-nil invite key")
		}

		pubKeyBytes, _ := inviteKey.GetPublic().Raw()
		t.Logf("Created invite, public key: %x", pubKeyBytes[:8])
	})
}

// TestIntegration_P2PSync_TwoClientPropagation verifies that credential changes
// propagate between two clients connected to the same space via HeadUpdate/FullSync.
func TestIntegration_P2PSync_TwoClientPropagation(t *testing.T) {
	testNetwork.RequireNetwork()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// 1. Create two SDKClients with separate data directories
	clientA := newTestSDKClientWithDir(t, t.TempDir())
	clientB := newTestSDKClientWithDir(t, t.TempDir())

	t.Logf("Client A peer: %s", clientA.GetPeerID())
	t.Logf("Client B peer: %s", clientB.GetPeerID())

	// 2. Client A creates a community space with keys
	keys, err := GenerateSpaceKeySet()
	if err != nil {
		t.Fatalf("generating keys: %v", err)
	}

	result, err := clientA.CreateSpaceWithKeys(ctx, "ETestPropagation_Owner", SpaceTypeCommunity, keys)
	if err != nil {
		t.Fatalf("Client A creating space: %v", err)
	}
	spaceID := result.SpaceID
	t.Logf("Client A created space: %s", spaceID)

	// 3. Client A creates an open invite
	aclMgrA := NewMatouACLManager(clientA, nil)
	inviteKey, err := aclMgrA.CreateOpenInvite(ctx, spaceID, PermissionWrite.ToSDKPermissions())
	if err != nil {
		t.Fatalf("Client A creating invite: %v", err)
	}
	t.Logf("Client A created open invite")

	// 4. Client B joins using the invite key
	aclMgrB := NewMatouACLManager(clientB, nil)
	err = aclMgrB.JoinWithInvite(ctx, spaceID, inviteKey, []byte("ClientB"))
	if err != nil {
		t.Fatalf("Client B joining space: %v", err)
	}
	t.Logf("Client B joined space")

	// 5. Client A adds a credential to the space's tree
	treeMgrA := NewCredentialTreeManager(clientA, nil)
	cred := &CredentialPayload{
		SAID:      "ESAID_propagation_test_001",
		Issuer:    "ETestIssuer_A",
		Recipient: "ETestRecipient",
		Schema:    "EMatouMembershipSchemaV1",
		Data:      json.RawMessage(`{"role":"member","source":"clientA"}`),
		Timestamp: time.Now().Unix(),
	}

	changeID, err := treeMgrA.AddCredential(ctx, spaceID, cred, keys.SigningKey)
	if err != nil {
		t.Fatalf("Client A adding credential: %v", err)
	}
	t.Logf("Client A added credential, change ID: %s", changeID)

	// 6. Poll with timeout: Client B reads credentials via CredentialTreeManager
	treeMgrB := NewCredentialTreeManager(clientB, nil)

	var found bool
	pollDeadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(pollDeadline) {
		creds, err := treeMgrB.ReadCredentials(ctx, spaceID)
		if err != nil {
			// Tree may not be available yet on Client B — wait and retry
			time.Sleep(500 * time.Millisecond)
			continue
		}

		for _, c := range creds {
			if c.SAID == "ESAID_propagation_test_001" {
				found = true
				if c.Issuer != "ETestIssuer_A" {
					t.Errorf("issuer mismatch: got %s, want ETestIssuer_A", c.Issuer)
				}
				if c.Schema != "EMatouMembershipSchemaV1" {
					t.Errorf("schema mismatch: got %s, want EMatouMembershipSchemaV1", c.Schema)
				}
				t.Logf("Client B found credential: SAID=%s Issuer=%s Schema=%s", c.SAID, c.Issuer, c.Schema)
				break
			}
		}

		if found {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	// 7. Assert Client B sees Client A's credential
	if !found {
		t.Fatal("Client B did not receive Client A's credential within timeout")
	}
}

// newTestSDKClientWithDir creates an SDKClient using a specific data directory.
// This allows creating multiple clients with distinct storage for propagation tests.
func newTestSDKClientWithDir(t *testing.T, dataDir string) *SDKClient {
	t.Helper()
	configPath := testNetwork.GetHostConfigPath()
	client, err := NewSDKClient(configPath, &ClientOptions{
		DataDir: dataDir,
	})
	if err != nil {
		t.Fatalf("failed to create SDK client with dir %s: %v", dataDir, err)
	}
	t.Cleanup(func() { client.Close() })
	return client
}
