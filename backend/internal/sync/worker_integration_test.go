//go:build integration

// Integration test for syncChatOnce — verifies that the sync worker detects
// P2P-replicated chat objects and emits the correct SSE events.
//
// Run with:
//
//	MATOU_ANYSYNC_INFRA_DIR=<path> go test -tags=integration ./internal/sync/ -run "TestIntegration_SyncChatOnce" -v -timeout 180s
package sync

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/anyproto/any-sync/util/crypto"
	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/anysync/testnet"
	"github.com/matou-dao/backend/internal/api"
)

var testNetwork *testnet.Network

func TestMain(m *testing.M) {
	testNetwork = testnet.Setup()
	code := m.Run()
	testNetwork.Teardown()
	os.Exit(code)
}

func newTestClient(t *testing.T) *anysync.SDKClient {
	t.Helper()
	client, err := anysync.NewSDKClient(testNetwork.GetHostConfigPath(), &anysync.ClientOptions{
		DataDir: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("creating SDK client: %v", err)
	}
	t.Cleanup(func() { client.Close() })
	return client
}

// TestIntegration_SyncChatOnce verifies that syncChatOnce:
//  1. Seeds known state on first call (no SSE events)
//  2. Emits chat:message:new when a new P2P message appears
//  3. Emits chat:channel:new when a new P2P channel appears
//  4. Does NOT re-emit for already-known objects
func TestIntegration_SyncChatOnce(t *testing.T) {
	testNetwork.RequireNetwork()

	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	// --- Setup two peers ---
	clientA := newTestClient(t)
	clientB := newTestClient(t)
	t.Logf("Client A: %s", clientA.GetPeerID())
	t.Logf("Client B: %s", clientB.GetPeerID())

	// Client A creates space
	result, err := clientA.CreateSpace(ctx, "ESyncWorker_Owner", "anytype.space", nil)
	if err != nil {
		t.Fatalf("creating space: %v", err)
	}
	spaceID := result.SpaceID
	signingKeyA := result.Keys.SigningKey
	t.Logf("Space: %s", spaceID)

	// Wait for propagation
	waitFor(t, 30*time.Second, func() bool {
		_, err := clientB.GetSpace(ctx, spaceID)
		return err == nil
	}, "space propagation to B")

	// Make shareable + invite
	if err := clientA.MakeSpaceShareable(ctx, spaceID); err != nil {
		t.Fatalf("MakeSpaceShareable: %v", err)
	}

	aclMgr := anysync.NewMatouACLManager(clientA, nil)
	var inviteKey crypto.PrivKey
	waitFor(t, 30*time.Second, func() bool {
		inviteKey, err = aclMgr.CreateOpenInvite(ctx, spaceID, anysync.PermissionWrite.ToSDKPermissions())
		return err == nil
	}, "invite creation")

	// Client B joins
	aclMgrB := anysync.NewMatouACLManager(clientB, nil)
	waitFor(t, 30*time.Second, func() bool {
		return aclMgrB.JoinWithInvite(ctx, spaceID, inviteKey, []byte(`{"aid":"ESyncWorker_Joiner"}`)) == nil
	}, "B join space")
	t.Log("Client B joined")

	// --- Client A writes a channel + message before worker starts ---
	objMgrA := anysync.NewObjectTreeManager(clientA, nil, anysync.NewTreeCache())

	chanData, _ := json.Marshal(map[string]interface{}{
		"name": "general", "createdAt": time.Now().UTC().Format(time.RFC3339),
		"createdBy": "ESyncWorker_Owner",
	})
	_, err = objMgrA.AddObject(ctx, spaceID, &anysync.ObjectPayload{
		ID: "ChatChannel-seed-001", Type: "ChatChannel", Data: chanData,
		Timestamp: time.Now().Unix(), Version: 1,
	}, signingKeyA)
	if err != nil {
		t.Fatalf("A writing seed channel: %v", err)
	}

	msgData, _ := json.Marshal(map[string]interface{}{
		"channelId": "ChatChannel-seed-001", "senderAid": "ESyncWorker_Owner",
		"senderName": "Owner", "content": "seed message",
		"sentAt": time.Now().UTC().Format(time.RFC3339),
	})
	_, err = objMgrA.AddObject(ctx, spaceID, &anysync.ObjectPayload{
		ID: "ChatMessage-seed-001", Type: "ChatMessage", Data: msgData,
		Timestamp: time.Now().Unix(), Version: 1,
	}, signingKeyA)
	if err != nil {
		t.Fatalf("A writing seed message: %v", err)
	}

	// Wait for replication to B
	waitFor(t, 30*time.Second, func() bool {
		mgr := anysync.NewObjectTreeManager(clientB, nil, anysync.NewTreeCache())
		objs, err := mgr.ReadObjectsByType(ctx, spaceID, "ChatMessage")
		if err != nil {
			return false
		}
		for _, o := range objs {
			if o.ID == "ChatMessage-seed-001" {
				return true
			}
		}
		return false
	}, "seed message replication to B")
	t.Log("Seed objects replicated to B")

	// --- Set up Worker for Client B ---
	spaceMgr := anysync.NewSpaceManager(clientB, &anysync.SpaceManagerConfig{
		CommunitySpaceID: spaceID,
	})
	broker := api.NewEventBroker()
	worker := NewWorker(DefaultConfig(), spaceMgr, nil, broker)

	// Subscribe to SSE events
	eventCh := broker.Subscribe()
	defer broker.Unsubscribe(eventCh)

	// --- Test 1: First call seeds state, no events ---
	t.Log("Calling syncChatOnce (seed pass)...")
	worker.syncChatOnce(ctx)

	select {
	case evt := <-eventCh:
		t.Fatalf("Expected no events on seed pass, got: %s", evt.Type)
	case <-time.After(200 * time.Millisecond):
		t.Log("Seed pass: no events (correct)")
	}

	// Verify known maps were seeded
	worker.mu.RLock()
	if !worker.chatSeeded {
		t.Fatal("chatSeeded should be true after first call")
	}
	if _, ok := worker.knownChannels["ChatChannel-seed-001"]; !ok {
		t.Error("seed channel not in knownChannels")
	}
	if _, ok := worker.knownMessages["ChatMessage-seed-001"]; !ok {
		t.Error("seed message not in knownMessages")
	}
	worker.mu.RUnlock()

	// --- Test 2: Second call with no changes, no events ---
	t.Log("Calling syncChatOnce (no-change pass)...")
	worker.syncChatOnce(ctx)

	select {
	case evt := <-eventCh:
		t.Fatalf("Expected no events on no-change pass, got: %s", evt.Type)
	case <-time.After(200 * time.Millisecond):
		t.Log("No-change pass: no events (correct)")
	}

	// --- Test 3: Client A writes a new message, worker detects it ---
	t.Log("Client A writing new message...")
	newMsgData, _ := json.Marshal(map[string]interface{}{
		"channelId": "ChatChannel-seed-001", "senderAid": "ESyncWorker_Owner",
		"senderName": "Owner", "content": "hello via P2P",
		"sentAt": time.Now().UTC().Format(time.RFC3339),
	})
	_, err = objMgrA.AddObject(ctx, spaceID, &anysync.ObjectPayload{
		ID: "ChatMessage-new-001", Type: "ChatMessage", Data: newMsgData,
		Timestamp: time.Now().Unix(), Version: 1,
	}, signingKeyA)
	if err != nil {
		t.Fatalf("A writing new message: %v", err)
	}

	// Poll syncChatOnce until it detects the new message (tree cache may be stale)
	t.Log("Polling syncChatOnce for new message detection...")
	var gotNewMsg bool
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		worker.syncChatOnce(ctx)
		select {
		case evt := <-eventCh:
			if evt.Type == "chat:message:new" {
				data, ok := evt.Data.(map[string]interface{})
				if !ok {
					t.Fatalf("Event data is not map[string]interface{}: %T", evt.Data)
				}
				if data["messageId"] == "ChatMessage-new-001" {
					if data["content"] != "hello via P2P" {
						t.Errorf("Expected content 'hello via P2P', got: %v", data["content"])
					}
					if data["source"] != "p2p" {
						t.Errorf("Expected source 'p2p', got: %v", data["source"])
					}
					t.Logf("Detected new message: %v", data["messageId"])
					gotNewMsg = true
				}
			}
		case <-time.After(500 * time.Millisecond):
		}
		if gotNewMsg {
			break
		}
	}
	if !gotNewMsg {
		t.Fatal("syncChatOnce never emitted chat:message:new for ChatMessage-new-001")
	}

	// --- Test 4: Client A writes a new channel ---
	t.Log("Client A writing new channel...")
	newChanData, _ := json.Marshal(map[string]interface{}{
		"name": "random", "createdAt": time.Now().UTC().Format(time.RFC3339),
		"createdBy": "ESyncWorker_Owner",
	})
	_, err = objMgrA.AddObject(ctx, spaceID, &anysync.ObjectPayload{
		ID: "ChatChannel-new-001", Type: "ChatChannel", Data: newChanData,
		Timestamp: time.Now().Unix(), Version: 1,
	}, signingKeyA)
	if err != nil {
		t.Fatalf("A writing new channel: %v", err)
	}

	// Poll syncChatOnce until it detects the new channel
	t.Log("Polling syncChatOnce for new channel detection...")
	var gotNewChan bool
	deadline = time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		worker.syncChatOnce(ctx)
		select {
		case evt := <-eventCh:
			if evt.Type == "chat:channel:new" {
				data, ok := evt.Data.(map[string]interface{})
				if !ok {
					t.Fatalf("Event data is not map[string]interface{}: %T", evt.Data)
				}
				if data["channelId"] == "ChatChannel-new-001" {
					t.Logf("Detected new channel: %v", data["channelId"])
					gotNewChan = true
				}
			}
		case <-time.After(500 * time.Millisecond):
		}
		if gotNewChan {
			break
		}
	}
	if !gotNewChan {
		t.Fatal("syncChatOnce never emitted chat:channel:new for ChatChannel-new-001")
	}

	// --- Test 5: Repeat call — no duplicate events ---
	t.Log("Calling syncChatOnce (no-duplicate pass)...")
	worker.syncChatOnce(ctx)

	select {
	case evt := <-eventCh:
		t.Fatalf("Expected no duplicate events, got: %s", evt.Type)
	case <-time.After(200 * time.Millisecond):
		t.Log("No-duplicate pass: no events (correct)")
	}

	t.Log("All syncChatOnce tests passed")
}

// waitFor polls fn every 500ms until it returns true or timeout expires.
func waitFor(t *testing.T, timeout time.Duration, fn func() bool, desc string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("Timed out waiting for: %s", desc)
}
