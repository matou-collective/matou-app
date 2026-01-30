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

	"github.com/anyproto/any-sync/util/crypto"
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

// TestIntegration_P2PSync_TwoClientPropagation verifies that encrypted credential
// changes propagate between two clients via tree nodes using HeadUpdate/FullSync.
//
// Credentials are encrypted — Client B must join the space via ACL invite to
// receive the ReadKey needed to decrypt them.
//
// Flow:
//  1. Client A creates a space
//  2. Wait for space to propagate to tree nodes
//  3. Client A marks space as shareable on coordinator
//  4. Client A creates an open invite (ACL record with encrypted ReadKey)
//  5. Client B joins with the invite key → decrypts ReadKey
//  6. Client A creates a credential tree and adds an encrypted credential
//  7. Wait for credential tree to propagate to Client B
//  8. Client B reads credentials (decrypts with ReadKey obtained via invite)
func TestIntegration_P2PSync_TwoClientPropagation(t *testing.T) {
	testNetwork.RequireNetwork()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// 1. Create two SDKClients with separate data directories
	clientA := newTestSDKClientWithDir(t, t.TempDir())
	clientB := newTestSDKClientWithDir(t, t.TempDir())

	t.Logf("Client A peer: %s", clientA.GetPeerID())
	t.Logf("Client B peer: %s", clientB.GetPeerID())

	// 2. Client A creates a space
	result, err := clientA.CreateSpace(ctx, "ETestPropagation_Owner", "anytype.space", nil)
	if err != nil {
		t.Fatalf("Client A creating space: %v", err)
	}
	spaceID := result.SpaceID
	signingKey := result.Keys.SigningKey
	t.Logf("Client A created space: %s", spaceID)

	// 3. Wait for space to propagate to tree nodes via HeadSync.
	//    The consensus node learns about the space (ACL root) via tree nodes.
	//    We must wait for this before creating an invite, otherwise the
	//    consensus node returns "space not exists" when adding the ACL record.
	t.Log("Waiting for space to propagate to tree nodes via HeadSync...")
	pushDeadline := time.Now().Add(30 * time.Second)
	var spaceReady bool
	for time.Now().Before(pushDeadline) {
		_, err := clientB.GetSpace(ctx, spaceID)
		if err == nil {
			spaceReady = true
			break
		}
		time.Sleep(1 * time.Second)
	}
	if !spaceReady {
		t.Fatalf("Space did not propagate to tree nodes within timeout")
	}
	t.Log("Client B can access space from tree nodes")

	// 4. Mark the space as shareable on the coordinator so ACL invites are accepted.
	if err := clientA.MakeSpaceShareable(ctx, spaceID); err != nil {
		t.Fatalf("Client A making space shareable: %v", err)
	}
	t.Log("Space marked as shareable on coordinator")

	// 5. Client A creates an open invite so Client B can join and get the ReadKey.
	//    Retry because the consensus node may still be processing the ACL root.
	t.Log("Client A creating open invite...")
	aclMgr := NewMatouACLManager(clientA, nil)
	var inviteKey crypto.PrivKey
	inviteDeadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(inviteDeadline) {
		inviteKey, err = aclMgr.CreateOpenInvite(ctx, spaceID, PermissionWrite.ToSDKPermissions())
		if err == nil {
			break
		}
		t.Logf("Invite creation attempt failed (consensus may not have ACL root yet): %v", err)
		time.Sleep(2 * time.Second)
	}
	if inviteKey == nil {
		t.Fatalf("Client A could not create invite within timeout: %v", err)
	}
	t.Log("Client A created open invite")

	// 6. Client B joins the space using the invite key.
	//    The invite record may not have propagated yet, so poll with retries.
	t.Log("Client B joining space with invite key...")
	aclMgrB := NewMatouACLManager(clientB, nil)
	joinDeadline := time.Now().Add(30 * time.Second)
	var joined bool
	for time.Now().Before(joinDeadline) {
		err := aclMgrB.JoinWithInvite(ctx, spaceID, inviteKey, []byte(`{"aid":"ETestPropagation_Joiner"}`))
		if err == nil {
			joined = true
			break
		}
		t.Logf("Client B join attempt failed (invite may not have propagated yet): %v", err)
		time.Sleep(2 * time.Second)
	}
	if !joined {
		t.Fatalf("Client B could not join space within timeout")
	}
	t.Log("Client B joined space with invite key (has ReadKey)")

	// 7. Client A creates a credential tree and adds an encrypted credential
	treeMgrA := NewCredentialTreeManager(clientA, nil)
	cred := &CredentialPayload{
		SAID:      "ESAID_propagation_test_001",
		Issuer:    "ETestIssuer_A",
		Recipient: "ETestRecipient",
		Schema:    "EMatouMembershipSchemaV1",
		Data:      json.RawMessage(`{"role":"member","source":"clientA"}`),
		Timestamp: time.Now().Unix(),
	}

	changeID, err := treeMgrA.AddCredential(ctx, spaceID, cred, signingKey)
	if err != nil {
		t.Fatalf("Client A adding credential: %v", err)
	}
	t.Logf("Client A added encrypted credential, change ID: %s", changeID)

	// 8. Poll with timeout: Client B reads credentials via CredentialTreeManager.
	//    Client B can decrypt because it has the ReadKey from the invite/join flow.
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

	// 9. Assert Client B sees Client A's credential (decrypted via ReadKey)
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
