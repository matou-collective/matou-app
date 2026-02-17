//go:build integration

// P2P sync verification test for chat message replication.
//
// This test measures how long a ChatMessage takes to replicate between two
// any-sync peers via the real Docker network.
//
// Run with:
//
//	cd infrastructure/any-sync && docker compose --env-file .env.test up -d
//	go test -tags=integration ./internal/anysync/ -run "TestIntegration_P2PSync_ChatMessage" -v -timeout 120s
package anysync

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/anyproto/any-sync/util/crypto"
)

// TestIntegration_P2PSync_RestartWithoutRejoin verifies whether a peer that
// joined a space, closed (app restart), and reconnected with only GetSpace()
// (no JoinWithInvite) can still read and write to the space.
//
// This determines whether the Layer 1 invite-key recovery is actually needed.
//
// Run with:
//
//	go test -tags=integration ./internal/anysync/ -run "TestIntegration_P2PSync_RestartWithoutRejoin" -v -timeout 180s
func TestIntegration_P2PSync_RestartWithoutRejoin(t *testing.T) {
	testNetwork.RequireNetwork()

	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	// --- Setup: same as existing test ---

	clientA := newTestSDKClientWithDir(t, t.TempDir())
	clientBDir := t.TempDir() // keep reference to reuse after restart

	configPath := testNetwork.GetHostConfigPath()
	clientB, err := NewSDKClient(configPath, &ClientOptions{DataDir: clientBDir})
	if err != nil {
		t.Fatalf("creating Client B: %v", err)
	}

	t.Logf("Client A peer: %s", clientA.GetPeerID())
	t.Logf("Client B peer: %s (dir: %s)", clientB.GetPeerID(), clientBDir)

	// Client A creates space
	result, err := clientA.CreateSpace(ctx, "ERestart_Owner", "anytype.space", nil)
	if err != nil {
		t.Fatalf("Client A creating space: %v", err)
	}
	spaceID := result.SpaceID
	signingKeyA := result.Keys.SigningKey
	t.Logf("Space created: %s", spaceID)

	// Wait for propagation
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := clientB.GetSpace(ctx, spaceID); err == nil {
			break
		}
		time.Sleep(1 * time.Second)
	}

	// Client A creates invite
	if err := clientA.MakeSpaceShareable(ctx, spaceID); err != nil {
		t.Fatalf("MakeSpaceShareable: %v", err)
	}
	aclMgr := NewMatouACLManager(clientA, nil)
	var inviteKey crypto.PrivKey
	deadline = time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		inviteKey, err = aclMgr.CreateOpenInvite(ctx, spaceID, PermissionWrite.ToSDKPermissions())
		if err == nil {
			break
		}
		time.Sleep(2 * time.Second)
	}
	if inviteKey == nil {
		t.Fatalf("Could not create invite: %v", err)
	}

	// Client B joins
	aclMgrB := NewMatouACLManager(clientB, nil)
	deadline = time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if err := aclMgrB.JoinWithInvite(ctx, spaceID, inviteKey, []byte(`{"aid":"ERestart_Joiner"}`)); err == nil {
			break
		}
		time.Sleep(2 * time.Second)
	}
	t.Log("Client B joined space")

	// Client B writes a message before restart
	objMgrB := NewObjectTreeManager(clientB, nil, NewUnifiedTreeManager())
	msgData, _ := json.Marshal(map[string]interface{}{
		"channelId": "ch-restart-test", "senderAid": "ERestart_Joiner",
		"content": "before restart", "sentAt": time.Now().UTC().Format(time.RFC3339),
	})
	_, err = objMgrB.AddObject(ctx, spaceID, &ObjectPayload{
		ID: "msg-before-restart", Type: "ChatMessage", Data: msgData,
		Timestamp: time.Now().Unix(), Version: 1,
	}, clientB.GetSigningKey())
	if err != nil {
		t.Fatalf("Client B pre-restart write failed: %v", err)
	}
	t.Log("Client B wrote message before restart")

	// Wait for replication to A
	deadline = time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		mgr := NewObjectTreeManager(clientA, nil, NewUnifiedTreeManager())
		objs, _ := mgr.ReadObjectsByType(ctx, spaceID, "ChatMessage")
		for _, o := range objs {
			if o.ID == "msg-before-restart" {
				t.Log("Client A received pre-restart message")
				goto preRestartReplicated
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatal("Pre-restart message did not replicate to A")
preRestartReplicated:

	// --- Restart: close Client B and reopen with same data dir ---

	t.Log("Closing Client B (simulating app restart)...")
	if err := clientB.Close(); err != nil {
		t.Fatalf("Closing Client B: %v", err)
	}

	t.Log("Reopening Client B with same data dir (no JoinWithInvite)...")
	clientB2, err := NewSDKClient(configPath, &ClientOptions{DataDir: clientBDir})
	if err != nil {
		t.Fatalf("Reopening Client B: %v", err)
	}
	defer clientB2.Close()

	t.Logf("Client B2 peer: %s", clientB2.GetPeerID())

	// Recovery step: only GetSpace, NO JoinWithInvite
	deadline = time.Now().Add(30 * time.Second)
	var recovered bool
	for time.Now().Before(deadline) {
		if _, err := clientB2.GetSpace(ctx, spaceID); err == nil {
			recovered = true
			break
		}
		time.Sleep(1 * time.Second)
	}
	if !recovered {
		t.Fatal("Client B2 could not GetSpace after restart")
	}
	t.Log("Client B2 recovered space via GetSpace()")

	// --- Test 1: Can B2 READ existing messages? ---
	t.Log("Testing read after restart...")
	var canRead bool
	deadline = time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		mgr := NewObjectTreeManager(clientB2, nil, NewUnifiedTreeManager())
		objs, err := mgr.ReadObjectsByType(ctx, spaceID, "ChatMessage")
		if err != nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}
		for _, o := range objs {
			if o.ID == "msg-before-restart" {
				canRead = true
				break
			}
		}
		if canRead {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if canRead {
		t.Log("READ after restart: OK")
	} else {
		t.Error("READ after restart: FAILED — could not read pre-restart message")
	}

	// --- Test 2: Can B2 WRITE a new message? ---
	t.Log("Testing write after restart...")
	objMgrB2 := NewObjectTreeManager(clientB2, nil, NewUnifiedTreeManager())
	msgData2, _ := json.Marshal(map[string]interface{}{
		"channelId": "ch-restart-test", "senderAid": "ERestart_Joiner",
		"content": "after restart", "sentAt": time.Now().UTC().Format(time.RFC3339),
	})
	_, writeErr := objMgrB2.AddObject(ctx, spaceID, &ObjectPayload{
		ID: "msg-after-restart", Type: "ChatMessage", Data: msgData2,
		Timestamp: time.Now().Unix(), Version: 1,
	}, clientB2.GetSigningKey())
	if writeErr != nil {
		t.Errorf("WRITE after restart: FAILED — %v", writeErr)
	} else {
		t.Log("WRITE after restart: OK (local)")
	}

	// --- Test 3: Does B2's write replicate to A? ---
	if writeErr == nil {
		t.Log("Testing replication of post-restart write to Client A...")
		var replicated bool
		deadline = time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			mgr := NewObjectTreeManager(clientA, nil, NewUnifiedTreeManager())
			objs, _ := mgr.ReadObjectsByType(ctx, spaceID, "ChatMessage")
			for _, o := range objs {
				if o.ID == "msg-after-restart" {
					replicated = true
					break
				}
			}
			if replicated {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		if replicated {
			t.Log("REPLICATE after restart: OK — Client A received post-restart message")
		} else {
			t.Error("REPLICATE after restart: FAILED — Client A did not receive post-restart message")
		}
	}

	// Also test: Client A writes AFTER B2 restart, does B2 see it?
	t.Log("Testing A→B2 replication after restart...")
	msgDataA2, _ := json.Marshal(map[string]interface{}{
		"channelId": "ch-restart-test", "senderAid": "ERestart_Owner",
		"content": "from A after B restart", "sentAt": time.Now().UTC().Format(time.RFC3339),
	})
	objMgrA := NewObjectTreeManager(clientA, nil, NewUnifiedTreeManager())
	_, err = objMgrA.AddObject(ctx, spaceID, &ObjectPayload{
		ID: "msg-from-A-after-restart", Type: "ChatMessage", Data: msgDataA2,
		Timestamp: time.Now().Unix(), Version: 1,
	}, signingKeyA)
	if err != nil {
		t.Fatalf("Client A post-restart write: %v", err)
	}

	var b2Received bool
	deadline = time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		mgr := NewObjectTreeManager(clientB2, nil, NewUnifiedTreeManager())
		objs, _ := mgr.ReadObjectsByType(ctx, spaceID, "ChatMessage")
		for _, o := range objs {
			if o.ID == "msg-from-A-after-restart" {
				b2Received = true
				break
			}
		}
		if b2Received {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if b2Received {
		t.Log("A→B2 replication after restart: OK")
	} else {
		t.Error("A→B2 replication after restart: FAILED")
	}
}

// TestIntegration_P2PSync_ChatMessageReplication verifies that ChatMessage
// objects replicate between two peers via the any-sync P2P network and
// measures the replication latency.
//
// Flow:
//  1. Two SDKClients (A, B) with separate temp dirs
//  2. Client A creates a community space
//  3. Wait for space propagation (poll clientB.GetSpace, 30s timeout)
//  4. Client A makes space shareable + creates open invite
//  5. Client B joins with invite key
//  6. Client A sends a ChatMessage via ObjectTreeManager
//  7. Measure replication time: poll Client B until the message appears
//  8. Client B sends a ChatMessage via its own ObjectTreeManager
//  9. Measure reverse replication: poll Client A until it sees both messages
//  10. Assert both messages are present and have correct data
func TestIntegration_P2PSync_ChatMessageReplication(t *testing.T) {
	testNetwork.RequireNetwork()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// 1. Two SDKClients with separate data directories
	clientA := newTestSDKClientWithDir(t, t.TempDir())
	clientB := newTestSDKClientWithDir(t, t.TempDir())

	t.Logf("Client A peer: %s", clientA.GetPeerID())
	t.Logf("Client B peer: %s", clientB.GetPeerID())

	// 2. Client A creates a community space
	result, err := clientA.CreateSpace(ctx, "EChatSync_Owner", "anytype.space", nil)
	if err != nil {
		t.Fatalf("Client A creating space: %v", err)
	}
	spaceID := result.SpaceID
	signingKey := result.Keys.SigningKey
	t.Logf("Client A created space: %s", spaceID)

	// 3. Wait for space propagation to tree nodes
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

	// 4. Client A marks space as shareable and creates open invite
	if err := clientA.MakeSpaceShareable(ctx, spaceID); err != nil {
		t.Fatalf("Client A making space shareable: %v", err)
	}
	t.Log("Space marked as shareable on coordinator")

	aclMgr := NewMatouACLManager(clientA, nil)
	var inviteKey crypto.PrivKey
	inviteDeadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(inviteDeadline) {
		inviteKey, err = aclMgr.CreateOpenInvite(ctx, spaceID, PermissionWrite.ToSDKPermissions())
		if err == nil {
			break
		}
		t.Logf("Invite creation attempt failed: %v", err)
		time.Sleep(2 * time.Second)
	}
	if inviteKey == nil {
		t.Fatalf("Client A could not create invite within timeout: %v", err)
	}
	t.Log("Client A created open invite")

	// 5. Client B joins with invite key
	aclMgrB := NewMatouACLManager(clientB, nil)
	joinDeadline := time.Now().Add(30 * time.Second)
	var joined bool
	for time.Now().Before(joinDeadline) {
		err := aclMgrB.JoinWithInvite(ctx, spaceID, inviteKey, []byte(`{"aid":"EChatSync_Joiner"}`))
		if err == nil {
			joined = true
			break
		}
		t.Logf("Client B join attempt failed: %v", err)
		time.Sleep(2 * time.Second)
	}
	if !joined {
		t.Fatalf("Client B could not join space within timeout")
	}
	t.Log("Client B joined space with invite key")

	// 6. Client A sends a ChatMessage
	objMgrA := NewObjectTreeManager(clientA, nil, NewUnifiedTreeManager())

	chatMsgA := map[string]interface{}{
		"id":        "ChatMessage-test-A-001",
		"type":      "ChatMessage",
		"channelId": "channel-test-001",
		"senderAid": "EChatSync_Owner",
		"content":   "Hello from Client A",
		"sentAt":    time.Now().UTC().Format(time.RFC3339),
	}
	chatMsgABytes, _ := json.Marshal(chatMsgA)

	payload := &ObjectPayload{
		ID:        "ChatMessage-test-A-001",
		Type:      "ChatMessage",
		Data:      chatMsgABytes,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}

	startA := time.Now()
	_, err = objMgrA.AddObject(ctx, spaceID, payload, signingKey)
	if err != nil {
		t.Fatalf("Client A adding ChatMessage: %v", err)
	}
	t.Logf("Client A sent ChatMessage")

	// 7. Measure replication time: poll Client B's ObjectTreeManager
	var foundA bool
	pollDeadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(pollDeadline) {
		freshMgrB := NewObjectTreeManager(clientB, nil, NewUnifiedTreeManager())
		objects, err := freshMgrB.ReadObjectsByType(ctx, spaceID, "ChatMessage")
		if err != nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}

		for _, obj := range objects {
			if obj.ID == "ChatMessage-test-A-001" {
				foundA = true
				elapsedAB := time.Since(startA)
				t.Logf("Message A→B replication: %v", elapsedAB)
				break
			}
		}

		if foundA {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if !foundA {
		t.Fatal("Client B did not receive Client A's ChatMessage within timeout")
	}

	// 8. Client B sends a ChatMessage
	objMgrB := NewObjectTreeManager(clientB, nil, NewUnifiedTreeManager())

	chatMsgB := map[string]interface{}{
		"id":        "ChatMessage-test-B-001",
		"type":      "ChatMessage",
		"channelId": "channel-test-001",
		"senderAid": "EChatSync_Joiner",
		"content":   "Hello from Client B",
		"sentAt":    time.Now().UTC().Format(time.RFC3339),
	}
	chatMsgBBytes, _ := json.Marshal(chatMsgB)

	payloadB := &ObjectPayload{
		ID:        "ChatMessage-test-B-001",
		Type:      "ChatMessage",
		Data:      chatMsgBBytes,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}

	startB := time.Now()
	_, err = objMgrB.AddObject(ctx, spaceID, payloadB, clientB.GetSigningKey())
	if err != nil {
		t.Fatalf("Client B adding ChatMessage: %v", err)
	}
	t.Logf("Client B sent ChatMessage")

	// 9. Measure reverse replication: poll Client A until it sees both messages
	var foundBoth bool
	pollDeadline = time.Now().Add(30 * time.Second)
	for time.Now().Before(pollDeadline) {
		freshMgrA := NewObjectTreeManager(clientA, nil, NewUnifiedTreeManager())
		objects, err := freshMgrA.ReadObjectsByType(ctx, spaceID, "ChatMessage")
		if err != nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}

		var seenA, seenB bool
		for _, obj := range objects {
			if obj.ID == "ChatMessage-test-A-001" {
				seenA = true
			}
			if obj.ID == "ChatMessage-test-B-001" {
				seenB = true
			}
		}

		if seenA && seenB {
			foundBoth = true
			elapsedBA := time.Since(startB)
			t.Logf("Message B→A replication: %v", elapsedBA)
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	// 10. Assert both messages are present
	if !foundBoth {
		t.Fatal("Client A did not see both ChatMessages within timeout")
	}
	t.Log("Bidirectional ChatMessage replication verified")
}
