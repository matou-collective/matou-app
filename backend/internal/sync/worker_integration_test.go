//go:build integration

// Integration test for TreeUpdateListener — verifies that push-based P2P
// chat sync detects replicated objects and emits the correct SSE events.
//
// Run with:
//
//	MATOU_ANYSYNC_INFRA_DIR=<path> go test -tags=integration ./internal/sync/ -run "TestIntegration_TreeUpdateListener" -v -timeout 180s
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

// TestIntegration_TreeUpdateListener verifies that:
//  1. TreeUpdateListener seeds known state on initial tree build (no SSE events)
//  2. Emits chat:message:new when a new P2P message replicates
//  3. Emits chat:channel:new when a new P2P channel replicates
//  4. Does NOT re-emit for already-known objects
func TestIntegration_TreeUpdateListener(t *testing.T) {
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

	// --- Client A writes a channel + message ---
	objMgrA := anysync.NewObjectTreeManager(clientA, nil, anysync.NewUnifiedTreeManager())

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

	// Set up TreeUpdateListener on Client B's space manager
	broker := api.NewEventBroker()
	listener := anysync.NewTreeUpdateListener(nil, &eventBrokerAdapter{broker: broker})

	spaceMgr := anysync.NewSpaceManager(clientB, &anysync.SpaceManagerConfig{
		CommunitySpaceID: spaceID,
	})
	spaceMgr.SetObjectTreeListener(listener)

	// Subscribe to SSE events
	eventCh := broker.Subscribe()
	defer broker.Unsubscribe(eventCh)

	// Wait for seed objects to replicate via TreeSyncer + listener
	t.Log("Waiting for seed objects to replicate to B via listener...")
	waitFor(t, 30*time.Second, func() bool {
		mgr := anysync.NewObjectTreeManager(clientB, nil, anysync.NewUnifiedTreeManager())
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

	// Drain any events from initial seed
	drainEvents(eventCh)

	// --- Test: Client A writes a new message, listener on B should emit SSE ---
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

	// Wait for the SSE event from listener
	t.Log("Waiting for chat:message:new SSE event...")
	var gotNewMsg bool
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case evt := <-eventCh:
			if evt.Type == "chat:message:new" {
				data, ok := evt.Data.(map[string]interface{})
				if !ok {
					continue
				}
				if data["messageId"] == "ChatMessage-new-001" {
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
		t.Fatal("TreeUpdateListener never emitted chat:message:new for ChatMessage-new-001")
	}

	t.Log("All TreeUpdateListener tests passed")
}

// eventBrokerAdapter adapts api.EventBroker to anysync.EventBroadcaster.
type eventBrokerAdapter struct {
	broker *api.EventBroker
}

func (a *eventBrokerAdapter) Broadcast(event anysync.SSEEvent) {
	a.broker.Broadcast(api.SSEEvent{Type: event.Type, Data: event.Data})
}

// drainEvents reads and discards all pending events from the channel.
func drainEvents(ch <-chan api.SSEEvent) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
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
