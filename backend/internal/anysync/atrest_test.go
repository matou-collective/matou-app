package anysync

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strings"
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

// TestUserSignKey_SealedRoundTrip proves PersistUserSignKey / LoadUserSignKey
// seal at rest and round-trip, and fail closed on the wrong key.
func TestUserSignKey_SealedRoundTrip(t *testing.T) {
	dir := t.TempDir()
	RegisterDataDirKey(dir, testEncKey)

	priv, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		t.Fatalf("generating key: %v", err)
	}
	const aid = "EAID123"
	if err := PersistUserSignKey(dir, aid, priv); err != nil {
		t.Fatalf("PersistUserSignKey: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "users", aid, "sign.key"))
	if err != nil {
		t.Fatalf("reading user sign key: %v", err)
	}
	if !identity.IsSealed(raw) {
		t.Fatal("expected user sign.key to be sealed at rest")
	}

	loaded, err := LoadUserSignKey(dir, aid)
	if err != nil {
		t.Fatalf("LoadUserSignKey: %v", err)
	}
	if loaded.GetPublic().PeerId() != priv.GetPublic().PeerId() {
		t.Error("user sign key mismatch after round-trip")
	}

	// Wrong key fails closed.
	RegisterDataDirKey(dir, []byte("wrong-key"))
	defer RegisterDataDirKey(dir, nil)
	if _, err := LoadUserSignKey(dir, aid); err == nil {
		t.Fatal("expected error loading user sign key with wrong key")
	}
}

// TestNewPeerKeyManager_UnreadableSealedDeviceKeyRecovers proves a sealed
// peer.key that cannot be opened (shell key lost/rotated, or a launch with no
// key at all) does not lock the node out: the unreadable file is moved aside
// byte-for-byte, a fresh random device key is minted, and the manager comes
// up. The device key is a random per-install transport key (#468), so a new
// one only changes the peer id; identity/set re-persists it. Space read keys
// stay fail-closed (TestLoadSpaceKeySet_WrongKeyFailsClosed).
func TestNewPeerKeyManager_UnreadableSealedDeviceKeyRecovers(t *testing.T) {
	seed := func(t *testing.T) (dir, keyPath string, sealedRaw []byte) {
		t.Helper()
		dir = t.TempDir()
		keyPath = filepath.Join(dir, "peer.key")
		RegisterDataDirKey(dir, testEncKey)
		if _, err := GetOrCreatePeerKey(keyPath); err != nil {
			t.Fatalf("seeding sealed peer.key: %v", err)
		}
		sealedRaw, err := os.ReadFile(keyPath)
		if err != nil {
			t.Fatalf("reading seeded peer.key: %v", err)
		}
		if !identity.IsSealed(sealedRaw) {
			t.Fatal("precondition: seeded peer.key must be sealed")
		}
		return dir, keyPath, sealedRaw
	}

	assertMovedAside := func(t *testing.T, dir string, sealedRaw []byte) {
		t.Helper()
		matches, err := filepath.Glob(filepath.Join(dir, "peer.key.unreadable-*"))
		if err != nil {
			t.Fatalf("glob: %v", err)
		}
		if len(matches) != 1 {
			t.Fatalf("expected exactly one peer.key.unreadable-* file, got %v", matches)
		}
		preserved, err := os.ReadFile(matches[0])
		if err != nil {
			t.Fatalf("reading preserved file: %v", err)
		}
		if !bytes.Equal(preserved, sealedRaw) {
			t.Error("moved-aside file must preserve the original sealed bytes")
		}
	}

	t.Run("no key registered", func(t *testing.T) {
		dir, keyPath, sealedRaw := seed(t)
		RegisterDataDirKey(dir, nil)

		mgr, err := NewPeerKeyManager(&PeerKeyConfig{KeyPath: keyPath})
		if err != nil {
			t.Fatalf("NewPeerKeyManager must recover from an unreadable sealed peer.key: %v", err)
		}
		assertMovedAside(t, dir, sealedRaw)

		raw, err := os.ReadFile(keyPath)
		if err != nil {
			t.Fatalf("reading new peer.key: %v", err)
		}
		if identity.IsSealed(raw) {
			t.Error("with no key registered the fresh peer.key must be plaintext")
		}
		fresh, err := crypto.UnmarshalEd25519PrivateKeyProto(raw)
		if err != nil {
			t.Fatalf("fresh peer.key must be a valid key: %v", err)
		}
		if fresh.GetPublic().PeerId() != mgr.GetPeerID() {
			t.Error("peer.key on disk must match the manager's device key")
		}
	})

	t.Run("wrong key registered, with mnemonic", func(t *testing.T) {
		dir, keyPath, sealedRaw := seed(t)
		RegisterDataDirKey(dir, []byte("rotated-shell-key"))
		defer RegisterDataDirKey(dir, nil)

		mgr, err := NewPeerKeyManager(&PeerKeyConfig{KeyPath: keyPath, Mnemonic: testMnemonic})
		if err != nil {
			t.Fatalf("NewPeerKeyManager must recover from a peer.key sealed under another key: %v", err)
		}
		assertMovedAside(t, dir, sealedRaw)

		// Sign key is still the mnemonic-derived ACL identity.
		derived, _ := DeriveKeyFromMnemonic(testMnemonic, 0)
		if !privKeysEqual(mgr.GetSigningKey(), derived) {
			t.Error("recovery must not touch the mnemonic-derived sign key")
		}
		if privKeysEqual(mgr.GetPeerKey(), derived) {
			t.Error("fresh device key must be distinct from the sign key")
		}

		// The fresh device key is sealed under the now-current key and stable.
		raw, err := os.ReadFile(keyPath)
		if err != nil {
			t.Fatalf("reading new peer.key: %v", err)
		}
		if !identity.IsSealed(raw) {
			t.Error("fresh peer.key must be sealed under the registered key")
		}
		mgr2, err := NewPeerKeyManager(&PeerKeyConfig{KeyPath: keyPath, Mnemonic: testMnemonic})
		if err != nil {
			t.Fatalf("second manager: %v", err)
		}
		if mgr2.GetPeerID() != mgr.GetPeerID() {
			t.Error("recovered device key must be stable across restarts")
		}
	})
}

// TestRegisterDataDirKey_UncleanPathStillSeals proves the registry is keyed by
// the cleaned path: a data dir registered with a trailing slash or as ./data
// must still seal peer.key (looked up via filepath.Dir, which cleans) and the
// space key bundles. Before this, an unclean MATOU_DATA_DIR silently wrote
// peer.key in plaintext next to sealed keys/*.keys.
func TestRegisterDataDirKey_UncleanPathStillSeals(t *testing.T) {
	check := func(t *testing.T, registeredAs, dir string) {
		t.Helper()
		RegisterDataDirKey(registeredAs, testEncKey)
		t.Cleanup(func() { RegisterDataDirKey(registeredAs, nil) })

		keyPath := filepath.Join(dir, "peer.key")
		if _, err := GetOrCreatePeerKey(keyPath); err != nil {
			t.Fatalf("GetOrCreatePeerKey: %v", err)
		}
		raw, err := os.ReadFile(keyPath)
		if err != nil {
			t.Fatalf("reading peer.key: %v", err)
		}
		if !identity.IsSealed(raw) {
			t.Errorf("peer.key written plaintext although %q is registered", registeredAs)
		}

		keys, err := GenerateSpaceKeySet()
		if err != nil {
			t.Fatalf("GenerateSpaceKeySet: %v", err)
		}
		const spaceID = "space-unclean"
		// Persist via the unclean form, load via the clean form.
		if err := PersistSpaceKeySet(registeredAs, spaceID, keys); err != nil {
			t.Fatalf("PersistSpaceKeySet: %v", err)
		}
		if !identity.IsSealed(readSpaceKeyRaw(t, dir, spaceID)) {
			t.Errorf("space key bundle written plaintext although %q is registered", registeredAs)
		}
		loaded, err := LoadSpaceKeySet(dir, spaceID)
		if err != nil {
			t.Fatalf("LoadSpaceKeySet via clean path: %v", err)
		}
		sameKeySet(t, keys, loaded)

		// Clearing via the clean form clears the unclean registration too.
		RegisterDataDirKey(dir, nil)
		if k := dataDirEncKey(registeredAs); k != nil {
			t.Error("clearing via the clean path must clear the registration")
		}
	}

	t.Run("trailing slash", func(t *testing.T) {
		dir := t.TempDir()
		check(t, dir+string(filepath.Separator), dir)
	})

	t.Run("dot-relative", func(t *testing.T) {
		t.Chdir(t.TempDir())
		check(t, "./data", "data")
	})
}

// TestMigrationWarnings_GoToLog proves a failed plaintext→sealed migration is
// best-effort (the load still succeeds) and that the warning is written via
// the log package (stderr), which the e2e BackendManager captures — not via
// fmt.Printf to stdout, which it does not.
func TestMigrationWarnings_GoToLog(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("read-only file permissions are not enforced for root")
	}
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })

	dir := t.TempDir()
	keyPath := filepath.Join(dir, "peer.key")
	priv, err := GetOrCreatePeerKey(keyPath) // plaintext, no key registered
	if err != nil {
		t.Fatalf("GetOrCreatePeerKey: %v", err)
	}
	keys, err := GenerateSpaceKeySet()
	if err != nil {
		t.Fatalf("GenerateSpaceKeySet: %v", err)
	}
	const spaceID = "space-ro"
	if err := PersistSpaceKeySet(dir, spaceID, keys); err != nil {
		t.Fatalf("PersistSpaceKeySet: %v", err)
	}
	bundlePath := filepath.Join(dir, "keys", spaceID+".keys")

	// Make both files unwritable so the in-place migration fails.
	for _, p := range []string{keyPath, bundlePath} {
		if err := os.Chmod(p, 0400); err != nil {
			t.Fatalf("chmod: %v", err)
		}
		t.Cleanup(func() { _ = os.Chmod(p, 0600) })
	}

	RegisterDataDirKey(dir, testEncKey)
	t.Cleanup(func() { RegisterDataDirKey(dir, nil) })

	reloaded, err := GetOrCreatePeerKey(keyPath)
	if err != nil {
		t.Fatalf("a failed peer.key migration must not fail the load: %v", err)
	}
	if reloaded.GetPublic().PeerId() != priv.GetPublic().PeerId() {
		t.Error("peer key changed when migration failed")
	}
	loaded, err := LoadSpaceKeySet(dir, spaceID)
	if err != nil {
		t.Fatalf("a failed bundle migration must not fail the load: %v", err)
	}
	sameKeySet(t, keys, loaded)

	out := buf.String()
	if !strings.Contains(out, "failed to migrate peer.key") {
		t.Errorf("peer.key migration warning not written via log: %q", out)
	}
	if !strings.Contains(out, "failed to migrate "+spaceID+".keys") {
		t.Errorf("space key migration warning not written via log: %q", out)
	}
}

// TestLoadUserSignKey_LegacyAndMigration covers the users/{aid} read path
// under #468's sign.key layout:
//   - a sealed legacy users/{aid}/peer.key is opened through the fallback;
//   - a plaintext key (sign.key or legacy peer.key) is migrated on first keyed
//     open to a sealed sign.key, and a plaintext legacy peer.key is removed once
//     the sealed sign.key exists — the ACL identity must not stay on disk in
//     the clear after the rest of the key material is sealed.
func TestLoadUserSignKey_LegacyAndMigration(t *testing.T) {
	const aid = "EAIDLEGACY"
	newKey := func(t *testing.T) (crypto.PrivKey, []byte) {
		t.Helper()
		priv, _, err := crypto.GenerateRandomEd25519KeyPair()
		if err != nil {
			t.Fatalf("generating key: %v", err)
		}
		raw, err := priv.Marshall()
		if err != nil {
			t.Fatalf("marshalling key: %v", err)
		}
		return priv, raw
	}
	writeUserFile := func(t *testing.T, dir, name string, data []byte) string {
		t.Helper()
		userDir := filepath.Join(dir, "users", aid)
		if err := os.MkdirAll(userDir, 0700); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		p := filepath.Join(userDir, name)
		if err := os.WriteFile(p, data, 0600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		return p
	}

	t.Run("sealed legacy peer.key is read via fallback", func(t *testing.T) {
		dir := t.TempDir()
		RegisterDataDirKey(dir, testEncKey)
		t.Cleanup(func() { RegisterDataDirKey(dir, nil) })
		priv, raw := newKey(t)
		sealed, err := identity.Seal(raw, testEncKey)
		if err != nil {
			t.Fatalf("seal: %v", err)
		}
		writeUserFile(t, dir, "peer.key", sealed)

		loaded, err := LoadUserSignKey(dir, aid)
		if err != nil {
			t.Fatalf("LoadUserSignKey via sealed legacy file: %v", err)
		}
		if !privKeysEqual(loaded, priv) {
			t.Error("loaded key does not match the sealed legacy key")
		}
	})

	t.Run("plaintext legacy peer.key migrates to sealed sign.key", func(t *testing.T) {
		dir := t.TempDir()
		priv, raw := newKey(t)
		legacyPath := writeUserFile(t, dir, "peer.key", raw)

		RegisterDataDirKey(dir, testEncKey)
		t.Cleanup(func() { RegisterDataDirKey(dir, nil) })

		loaded, err := LoadUserSignKey(dir, aid)
		if err != nil {
			t.Fatalf("LoadUserSignKey: %v", err)
		}
		if !privKeysEqual(loaded, priv) {
			t.Error("loaded key does not match the legacy key")
		}

		signRaw, err := os.ReadFile(filepath.Join(dir, "users", aid, "sign.key"))
		if err != nil {
			t.Fatalf("sign.key must exist after migration: %v", err)
		}
		if !identity.IsSealed(signRaw) {
			t.Error("migrated sign.key must be sealed")
		}
		if bytes.Contains(signRaw, raw) {
			t.Error("migrated sign.key leaks raw key bytes")
		}
		if _, err := os.Stat(legacyPath); !os.IsNotExist(err) {
			t.Errorf("plaintext legacy peer.key must be removed after migration (stat err=%v)", err)
		}

		again, err := LoadUserSignKey(dir, aid)
		if err != nil {
			t.Fatalf("LoadUserSignKey after migration: %v", err)
		}
		if !privKeysEqual(again, priv) {
			t.Error("post-migration key mismatch")
		}
	})

	t.Run("plaintext sign.key migrates in place", func(t *testing.T) {
		dir := t.TempDir()
		priv, raw := newKey(t)
		signPath := writeUserFile(t, dir, "sign.key", raw)

		RegisterDataDirKey(dir, testEncKey)
		t.Cleanup(func() { RegisterDataDirKey(dir, nil) })

		loaded, err := LoadUserSignKey(dir, aid)
		if err != nil {
			t.Fatalf("LoadUserSignKey: %v", err)
		}
		if !privKeysEqual(loaded, priv) {
			t.Error("loaded key mismatch")
		}
		signRaw, err := os.ReadFile(signPath)
		if err != nil {
			t.Fatalf("read sign.key: %v", err)
		}
		if !identity.IsSealed(signRaw) {
			t.Error("sign.key must be sealed after first keyed open")
		}
	})

	t.Run("no key registered leaves plaintext files untouched", func(t *testing.T) {
		dir := t.TempDir()
		priv, raw := newKey(t)
		legacyPath := writeUserFile(t, dir, "peer.key", raw)

		loaded, err := LoadUserSignKey(dir, aid)
		if err != nil {
			t.Fatalf("LoadUserSignKey: %v", err)
		}
		if !privKeysEqual(loaded, priv) {
			t.Error("loaded key mismatch")
		}
		if _, err := os.Stat(legacyPath); err != nil {
			t.Errorf("legacy peer.key must be left in place without a key: %v", err)
		}
		if _, err := os.Stat(filepath.Join(dir, "users", aid, "sign.key")); !os.IsNotExist(err) {
			t.Error("no sign.key must be written without a key registered")
		}
	})
}
