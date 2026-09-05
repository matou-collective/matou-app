package anysync

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/anyproto/any-sync/util/crypto"

	"github.com/matou-dao/backend/internal/identity"
)

// testEncKey is arbitrary shell-supplied key material; the crypto normalises it
// to a 32-byte AES key via SHA-256, so any length works.
var testEncKey = []byte("shell-supplied-at-rest-key-material")

// readRaw returns the exact bytes on disk for a persisted space key bundle.
func readSpaceKeyRaw(t *testing.T, dataDir, spaceID string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dataDir, "keys", spaceID+".keys"))
	if err != nil {
		t.Fatalf("reading raw key file: %v", err)
	}
	return raw
}

func sameKeySet(t *testing.T, want, got *SpaceKeySet) {
	t.Helper()
	if want.SigningKey.GetPublic().PeerId() != got.SigningKey.GetPublic().PeerId() {
		t.Error("signing key mismatch after round-trip")
	}
	if want.MasterKey.GetPublic().PeerId() != got.MasterKey.GetPublic().PeerId() {
		t.Error("master key mismatch after round-trip")
	}
	if want.MetadataKey.GetPublic().PeerId() != got.MetadataKey.GetPublic().PeerId() {
		t.Error("metadata key mismatch after round-trip")
	}
	wantRead, err := want.ReadKey.Marshall()
	if err != nil {
		t.Fatalf("marshaling want read key: %v", err)
	}
	gotRead, err := got.ReadKey.Marshall()
	if err != nil {
		t.Fatalf("marshaling got read key: %v", err)
	}
	if !bytes.Equal(wantRead, gotRead) {
		t.Error("read key mismatch after round-trip")
	}
}

// TestPersistSpaceKeySet_SealedAtRest is the core proof: with a key registered
// the bundle on disk is sealed, does not contain the raw read/signing key
// bytes, and round-trips.
func TestPersistSpaceKeySet_SealedAtRest(t *testing.T) {
	dir := t.TempDir()
	RegisterDataDirKey(dir, testEncKey)
	defer RegisterDataDirKey(dir, nil)

	keys, err := GenerateSpaceKeySet()
	if err != nil {
		t.Fatalf("GenerateSpaceKeySet: %v", err)
	}
	const spaceID = "space-sealed"
	if err := PersistSpaceKeySet(dir, spaceID, keys); err != nil {
		t.Fatalf("PersistSpaceKeySet: %v", err)
	}

	raw := readSpaceKeyRaw(t, dir, spaceID)
	if !identity.IsSealed(raw) {
		t.Fatal("expected key bundle to be sealed at rest")
	}

	// The raw read key and signing key bytes must not appear in the sealed file.
	readBytes, _ := keys.ReadKey.Marshall()
	if bytes.Contains(raw, readBytes) {
		t.Error("sealed file leaks raw read key bytes")
	}
	sigBytes, _ := keys.SigningKey.Marshall()
	if bytes.Contains(raw, sigBytes) {
		t.Error("sealed file leaks raw signing key bytes")
	}

	loaded, err := LoadSpaceKeySet(dir, spaceID)
	if err != nil {
		t.Fatalf("LoadSpaceKeySet: %v", err)
	}
	sameKeySet(t, keys, loaded)
}

// TestPersistSpaceKeySet_NoKeyPlaintext proves the no-key path is unchanged:
// the bundle is written as legacy plaintext JSON.
func TestPersistSpaceKeySet_NoKeyPlaintext(t *testing.T) {
	dir := t.TempDir()
	// No RegisterDataDirKey call — legacy path.

	keys, err := GenerateSpaceKeySet()
	if err != nil {
		t.Fatalf("GenerateSpaceKeySet: %v", err)
	}
	const spaceID = "space-plain"
	if err := PersistSpaceKeySet(dir, spaceID, keys); err != nil {
		t.Fatalf("PersistSpaceKeySet: %v", err)
	}

	raw := readSpaceKeyRaw(t, dir, spaceID)
	if identity.IsSealed(raw) {
		t.Fatal("expected legacy plaintext bundle without a registered key")
	}
	if len(raw) == 0 || raw[0] != '{' {
		t.Fatalf("expected JSON document, got %q...", raw[:min(len(raw), 16)])
	}

	loaded, err := LoadSpaceKeySet(dir, spaceID)
	if err != nil {
		t.Fatalf("LoadSpaceKeySet: %v", err)
	}
	sameKeySet(t, keys, loaded)
}

// TestLoadSpaceKeySet_PlaintextMigration proves a legacy plaintext bundle is
// migrated to sealed form the first time it is loaded with a key registered.
func TestLoadSpaceKeySet_PlaintextMigration(t *testing.T) {
	dir := t.TempDir()

	keys, err := GenerateSpaceKeySet()
	if err != nil {
		t.Fatalf("GenerateSpaceKeySet: %v", err)
	}
	const spaceID = "space-migrate"

	// Write plaintext first (no key registered).
	if err := PersistSpaceKeySet(dir, spaceID, keys); err != nil {
		t.Fatalf("PersistSpaceKeySet (plaintext): %v", err)
	}
	if identity.IsSealed(readSpaceKeyRaw(t, dir, spaceID)) {
		t.Fatal("precondition: file should be plaintext before migration")
	}

	// Now register a key and load — this should migrate the file in place.
	RegisterDataDirKey(dir, testEncKey)
	defer RegisterDataDirKey(dir, nil)

	loaded, err := LoadSpaceKeySet(dir, spaceID)
	if err != nil {
		t.Fatalf("LoadSpaceKeySet (migrating): %v", err)
	}
	sameKeySet(t, keys, loaded)

	if !identity.IsSealed(readSpaceKeyRaw(t, dir, spaceID)) {
		t.Fatal("expected file to be sealed after migration")
	}

	// A second load still round-trips from the now-sealed file.
	reloaded, err := LoadSpaceKeySet(dir, spaceID)
	if err != nil {
		t.Fatalf("LoadSpaceKeySet (post-migration): %v", err)
	}
	sameKeySet(t, keys, reloaded)
}

// TestLoadSpaceKeySet_WrongKeyFailsClosed proves a bundle sealed under one key
// cannot be opened with another — the load errors rather than returning junk.
func TestLoadSpaceKeySet_WrongKeyFailsClosed(t *testing.T) {
	dir := t.TempDir()
	RegisterDataDirKey(dir, testEncKey)

	keys, err := GenerateSpaceKeySet()
	if err != nil {
		t.Fatalf("GenerateSpaceKeySet: %v", err)
	}
	const spaceID = "space-wrongkey"
	if err := PersistSpaceKeySet(dir, spaceID, keys); err != nil {
		t.Fatalf("PersistSpaceKeySet: %v", err)
	}

	// Swap the registered key to a different one and try to load.
	RegisterDataDirKey(dir, []byte("a-completely-different-key"))
	defer RegisterDataDirKey(dir, nil)

	if _, err := LoadSpaceKeySet(dir, spaceID); err == nil {
		t.Fatal("expected error loading sealed bundle with wrong key")
	}

	// A sealed bundle with no key registered must also fail closed.
	RegisterDataDirKey(dir, nil)
	if _, err := LoadSpaceKeySet(dir, spaceID); err == nil {
		t.Fatal("expected error loading sealed bundle with no key registered")
	}
}

// TestGetOrCreatePeerKey_SealedAtRest proves the peer key is sealed at rest,
// round-trips, and does not leak the raw key bytes.
func TestGetOrCreatePeerKey_SealedAtRest(t *testing.T) {
	dir := t.TempDir()
	RegisterDataDirKey(dir, testEncKey)
	defer RegisterDataDirKey(dir, nil)

	keyPath := filepath.Join(dir, "peer.key")
	priv, err := GetOrCreatePeerKey(keyPath)
	if err != nil {
		t.Fatalf("GetOrCreatePeerKey: %v", err)
	}

	raw, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("reading peer.key: %v", err)
	}
	if !identity.IsSealed(raw) {
		t.Fatal("expected peer.key to be sealed at rest")
	}
	marshalled, _ := priv.Marshall()
	if bytes.Contains(raw, marshalled) {
		t.Error("sealed peer.key leaks raw key bytes")
	}

	// Reload returns the same key.
	reloaded, err := GetOrCreatePeerKey(keyPath)
	if err != nil {
		t.Fatalf("GetOrCreatePeerKey (reload): %v", err)
	}
	if reloaded.GetPublic().PeerId() != priv.GetPublic().PeerId() {
		t.Error("peer key changed after reload")
	}
}

// TestGetOrCreatePeerKey_NoKeyPlaintext proves the no-key path writes legacy
// plaintext, and TestGetOrCreatePeerKey_Migration proves migration on first
// keyed open.
func TestGetOrCreatePeerKey_NoKeyPlaintext(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "peer.key")
	if _, err := GetOrCreatePeerKey(keyPath); err != nil {
		t.Fatalf("GetOrCreatePeerKey: %v", err)
	}
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("reading peer.key: %v", err)
	}
	if identity.IsSealed(raw) {
		t.Fatal("expected legacy plaintext peer.key without a registered key")
	}
}

func TestGetOrCreatePeerKey_Migration(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "peer.key")

	// Plaintext first.
	priv, err := GetOrCreatePeerKey(keyPath)
	if err != nil {
		t.Fatalf("GetOrCreatePeerKey (plaintext): %v", err)
	}

	// Register a key and re-open — migrates in place.
	RegisterDataDirKey(dir, testEncKey)
	defer RegisterDataDirKey(dir, nil)

	migrated, err := GetOrCreatePeerKey(keyPath)
	if err != nil {
		t.Fatalf("GetOrCreatePeerKey (migrating): %v", err)
	}
	if migrated.GetPublic().PeerId() != priv.GetPublic().PeerId() {
		t.Error("peer key changed during migration")
	}
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("reading peer.key: %v", err)
	}
	if !identity.IsSealed(raw) {
		t.Fatal("expected peer.key to be sealed after migration")
	}
}

// TestUserPeerKey_SealedRoundTrip proves PersistUserPeerKey / LoadUserPeerKey
// seal at rest and round-trip, and fail closed on the wrong key.
func TestUserPeerKey_SealedRoundTrip(t *testing.T) {
	dir := t.TempDir()
	RegisterDataDirKey(dir, testEncKey)

	priv, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		t.Fatalf("generating key: %v", err)
	}
	const aid = "EAID123"
	if err := PersistUserPeerKey(dir, aid, priv); err != nil {
		t.Fatalf("PersistUserPeerKey: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "users", aid, "peer.key"))
	if err != nil {
		t.Fatalf("reading user peer key: %v", err)
	}
	if !identity.IsSealed(raw) {
		t.Fatal("expected user peer.key to be sealed at rest")
	}

	loaded, err := LoadUserPeerKey(dir, aid)
	if err != nil {
		t.Fatalf("LoadUserPeerKey: %v", err)
	}
	if loaded.GetPublic().PeerId() != priv.GetPublic().PeerId() {
		t.Error("user peer key mismatch after round-trip")
	}

	// Wrong key fails closed.
	RegisterDataDirKey(dir, []byte("wrong-key"))
	defer RegisterDataDirKey(dir, nil)
	if _, err := LoadUserPeerKey(dir, aid); err == nil {
		t.Fatal("expected error loading user peer key with wrong key")
	}
}
