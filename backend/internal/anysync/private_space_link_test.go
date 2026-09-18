//go:build integration

package anysync

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// newTestSDKClientWithMnemonic builds a client whose account (peer) signing key
// is derived from the given mnemonic — i.e. a device signed in with that
// recovery phrase. Two such clients for the same mnemonic share one account
// identity, which is exactly the linked-device situation.
func newTestSDKClientWithMnemonic(t *testing.T, dataDir, mnemonic string) *SDKClient {
	t.Helper()
	configPath := testNetwork.GetHostConfigPath()
	client, err := NewSDKClient(configPath, &ClientOptions{
		DataDir:  dataDir,
		Mnemonic: mnemonic,
	})
	if err != nil {
		t.Fatalf("failed to create mnemonic SDK client with dir %s: %v", dataDir, err)
	}
	t.Cleanup(func() { client.Close() })
	return client
}

// TestIntegration_PrivateSpace_LinkedDeviceReadsContent closes the #528 item 5
// test gap: nothing exercised reading pre-existing *private-space content* from
// a second device. S9 covers only the derived id and the SharedProfile (which
// lives in the community space, encrypted under a shared read key).
//
// This is the linked-device invariant end to end: device A "claims" by deriving
// the private space from the mnemonic and writing a PrivateProfile into it;
// device B, signed in with the same mnemonic, derives the *same* space id,
// opens it and reads that PrivateProfile back. It works only because
//   - both devices derive the same account key (DeriveKeyFromMnemonic(m, 0)),
//   - the derived space id is a pure function of that key + owner AID
//     (spaceDerivePayload), and
//   - any-sync derives the owner read key from the account key
//     (AclState.saveKeysFromRoot), so B decrypts A's write with no invite/join.
//
// If the SigningKey==account-key invariant (item 1) ever broke, B would open a
// space it cannot decrypt and this test would fail.
func TestIntegration_PrivateSpace_LinkedDeviceReadsContent(t *testing.T) {
	testNetwork.RequireNetwork()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	const ownerAID = "EPrivLink_Owner"

	// Device A and device B are both signed in with the same recovery phrase.
	clientA := newTestSDKClientWithMnemonic(t, t.TempDir(), testMnemonic)
	clientB := newTestSDKClientWithMnemonic(t, t.TempDir(), testMnemonic)
	t.Logf("Device A peer: %s", clientA.GetPeerID())
	t.Logf("Device B peer: %s", clientB.GetPeerID())

	// Device A claims: derive the private space key set and bind the space
	// signing key to the account key, exactly as the identity/set claim path
	// does (identity.go), then create the space at its derived id.
	keys, err := DeriveSpaceKeySet(testMnemonic, 0)
	if err != nil {
		t.Fatalf("deriving private space key set: %v", err)
	}
	keys.SigningKey = clientA.GetSigningKey()

	result, err := clientA.DeriveSpaceWithKeys(ctx, ownerAID, SpaceTypePrivate, keys)
	if err != nil {
		t.Fatalf("device A deriving private space: %v", err)
	}
	spaceID := result.SpaceID
	t.Logf("Device A derived private space: %s", spaceID)

	// Device A writes a PrivateProfile into the private space.
	profile := map[string]interface{}{
		"id":          "PrivateProfile-" + ownerAID,
		"type":        "PrivateProfile",
		"displayName": "Ada from device A",
		"updatedAt":   time.Now().UTC().Format(time.RFC3339),
	}
	profileBytes, _ := json.Marshal(profile)
	payload := &ObjectPayload{
		ID:        "PrivateProfile-" + ownerAID,
		Type:      "PrivateProfile",
		Data:      profileBytes,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}
	objMgrA := NewObjectTreeManager(clientA, nil, NewUnifiedTreeManager())
	if _, err := objMgrA.AddObject(ctx, spaceID, payload, clientA.GetSigningKey()); err != nil {
		t.Fatalf("device A writing PrivateProfile: %v", err)
	}
	t.Log("Device A wrote PrivateProfile into the private space")

	// Device B recomputes the same id from the mnemonic — no id is transmitted.
	idB, err := clientB.DeriveSpaceIDWithKeys(ctx, ownerAID, SpaceTypePrivate, keys)
	if err != nil {
		t.Fatalf("device B deriving private space id: %v", err)
	}
	if idB != spaceID {
		t.Fatalf("device B derived a different private space id: %s vs %s", idB, spaceID)
	}

	// Device B opens the space (adopt/link) and reads the pre-existing content.
	var found *ObjectPayload
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := clientB.GetSpace(ctx, spaceID); err != nil {
			time.Sleep(1 * time.Second)
			continue
		}
		mgrB := NewObjectTreeManager(clientB, nil, NewUnifiedTreeManager())
		objects, err := mgrB.ReadObjectsByType(ctx, spaceID, "PrivateProfile")
		if err != nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}
		for _, obj := range objects {
			if obj.ID == payload.ID {
				found = obj
				break
			}
		}
		if found != nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if found == nil {
		t.Fatal("device B never read device A's PrivateProfile from the private space")
	}

	// The decrypted content must match byte-for-byte — proof B derived the same
	// read key any-sync computed for A's owner key.
	var got map[string]interface{}
	if err := json.Unmarshal(found.Data, &got); err != nil {
		t.Fatalf("device B could not decode PrivateProfile: %v", err)
	}
	if got["displayName"] != "Ada from device A" {
		t.Errorf("device B read wrong PrivateProfile content: %v", got)
	}
	t.Log("Device B read device A's PrivateProfile content from the linked private space")
}
