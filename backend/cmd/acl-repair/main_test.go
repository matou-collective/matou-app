package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/util/crypto"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/identity"
)

const testMnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

func marshalKey(t *testing.T, keyBytesFn func() ([]byte, error)) []byte {
	t.Helper()
	b, err := keyBytesFn()
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	return b
}

// The mnemonic path must derive exactly the key that NewPeerKeyManager exposes
// as its sign key and that PersistUserSignKey writes to users/{aid}/sign.key —
// otherwise the repair would sign with an identity the ACL never trusted.
func TestResolveOwnerSignKey_MnemonicMatchesPersistedSignKey(t *testing.T) {
	dataDir := t.TempDir()

	mgr, err := anysync.NewPeerKeyManager(&anysync.PeerKeyConfig{
		KeyPath:  filepath.Join(dataDir, "peer.key"),
		Mnemonic: testMnemonic,
	})
	if err != nil {
		t.Fatalf("NewPeerKeyManager: %v", err)
	}
	appSign := mgr.GetSigningKey()

	// The device (transport) key must differ from the sign key post-#479.
	if string(marshalKey(t, mgr.GetPeerKey().Marshall)) == string(marshalKey(t, appSign.Marshall)) {
		t.Fatal("device peer key equals sign key — the #479 split is not in effect")
	}

	const aid = "EOwnerAID"
	if err := anysync.PersistUserSignKey(dataDir, aid, appSign); err != nil {
		t.Fatalf("PersistUserSignKey: %v", err)
	}

	resolved, desc, err := resolveOwnerSignKey(testMnemonic, "-mnemonic", "", 0)
	if err != nil {
		t.Fatalf("resolveOwnerSignKey(mnemonic): %v", err)
	}
	if !strings.Contains(desc, "-mnemonic") {
		t.Errorf("desc = %q, want it to mention -mnemonic", desc)
	}
	if strings.Contains(desc, "abandon") {
		t.Errorf("desc = %q leaks the mnemonic", desc)
	}

	want := marshalKey(t, appSign.Marshall)
	if got := marshalKey(t, resolved.Marshall); string(got) != string(want) {
		t.Error("mnemonic-derived key != NewPeerKeyManager sign key")
	}

	// And the same key loaded back from the persisted sign.key file.
	loaded, err := anysync.LoadUserSignKey(dataDir, aid)
	if err != nil {
		t.Fatalf("LoadUserSignKey: %v", err)
	}
	if got := marshalKey(t, loaded.Marshall); string(got) != string(want) {
		t.Error("persisted sign.key != mnemonic-derived key")
	}
}

// The -sign-key path must load the persisted sign.key and yield the same key as
// the mnemonic path.
func TestResolveOwnerSignKey_SignKeyFile(t *testing.T) {
	dataDir := t.TempDir()
	fromMnemonic, _, err := resolveOwnerSignKey(testMnemonic, "", "", 0)
	if err != nil {
		t.Fatalf("resolveOwnerSignKey(mnemonic): %v", err)
	}
	const aid = "EOwnerAID"
	if err := anysync.PersistUserSignKey(dataDir, aid, fromMnemonic); err != nil {
		t.Fatalf("PersistUserSignKey: %v", err)
	}
	path := filepath.Join(dataDir, "users", aid, "sign.key")

	resolved, desc, err := resolveOwnerSignKey("", "", path, 0)
	if err != nil {
		t.Fatalf("resolveOwnerSignKey(sign-key): %v", err)
	}
	if !strings.Contains(desc, path) {
		t.Errorf("desc = %q, want it to mention the sign-key path", desc)
	}
	if string(marshalKey(t, resolved.Marshall)) != string(marshalKey(t, fromMnemonic.Marshall)) {
		t.Error("sign-key file key != mnemonic-derived key")
	}
}

// Pre-#479 layout: {dataDir}/peer.key held the mnemonic-derived key itself.
// NewPeerKeyManager migrates such a file to a random device key on first boot,
// so the README tells operators to point -sign-key at a copy of the legacy
// peer.key — that copy must resolve to the same identity the mnemonic derives.
func TestResolveOwnerSignKey_LegacyPeerKeyLayout(t *testing.T) {
	dataDir := t.TempDir()
	derived, err := anysync.DeriveKeyFromMnemonic(testMnemonic, 0)
	if err != nil {
		t.Fatalf("DeriveKeyFromMnemonic: %v", err)
	}
	legacy := filepath.Join(dataDir, "peer.key")
	if err := os.WriteFile(legacy, marshalKey(t, derived.Marshall), 0600); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(dataDir, "peer.key.legacy-copy")
	if err := os.WriteFile(backup, marshalKey(t, derived.Marshall), 0600); err != nil {
		t.Fatal(err)
	}

	// Booting the app on this layout migrates peer.key to a random device key
	// while keeping the sign key.
	mgr, err := anysync.NewPeerKeyManager(&anysync.PeerKeyConfig{KeyPath: legacy, Mnemonic: testMnemonic})
	if err != nil {
		t.Fatalf("NewPeerKeyManager: %v", err)
	}
	if string(marshalKey(t, mgr.GetPeerKey().Marshall)) == string(marshalKey(t, derived.Marshall)) {
		t.Fatal("legacy peer.key was not migrated to a random device key")
	}

	resolved, _, err := resolveOwnerSignKey("", "", backup, 0)
	if err != nil {
		t.Fatalf("resolveOwnerSignKey(legacy peer.key): %v", err)
	}
	if string(marshalKey(t, resolved.Marshall)) != string(marshalKey(t, mgr.GetSigningKey().Marshall)) {
		t.Error("legacy peer.key copy != app sign key")
	}
}

func TestResolveOwnerSignKey_Errors(t *testing.T) {
	// No owner-identity source: the actionable failure path.
	_, _, err := resolveOwnerSignKey("", "", "", 0)
	if err == nil {
		t.Fatal("expected error when no owner-identity source is given")
	}
	for _, want := range []string{"-mnemonic", "-sign-key", envOwnerMnemonic} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q should name %s", err, want)
		}
	}

	// Both sources: ambiguous.
	if _, _, err := resolveOwnerSignKey(testMnemonic, "", "/tmp/whatever", 0); err == nil {
		t.Fatal("expected error when both a mnemonic and -sign-key are given")
	}

	// Invalid mnemonic: error must not echo the words back.
	const bad = "zebra zebra zebra not a valid mnemonic"
	_, _, err = resolveOwnerSignKey(bad, "-mnemonic-stdin", "", 0)
	if err == nil {
		t.Fatal("expected error for invalid mnemonic")
	}
	if strings.Contains(err.Error(), "zebra") {
		t.Errorf("error %q echoes the mnemonic", err)
	}
	if !strings.Contains(err.Error(), "-mnemonic-stdin") {
		t.Errorf("error %q should name the mnemonic source", err)
	}

	// Missing sign-key file.
	if _, _, err := resolveOwnerSignKey("", "", filepath.Join(t.TempDir(), "nope.key"), 0); err == nil {
		t.Fatal("expected error for missing sign-key file")
	}
}

// readMnemonic accepts exactly one of argv, stdin, env — and reads only the
// first line of stdin.
func TestReadMnemonic(t *testing.T) {
	m, src, err := readMnemonic("", false, "", strings.NewReader(""))
	if err != nil || m != "" || src != "" {
		t.Fatalf("no source: got (%q, %q, %v), want empty", m, src, err)
	}

	m, src, err = readMnemonic(" "+testMnemonic+" ", false, "", strings.NewReader(""))
	if err != nil || m != testMnemonic || src != "-mnemonic" {
		t.Fatalf("argv: got (%q, %q, %v)", m, src, err)
	}

	m, src, err = readMnemonic("", true, "", strings.NewReader(testMnemonic+"\nsecond line ignored\n"))
	if err != nil || m != testMnemonic || src != "-mnemonic-stdin" {
		t.Fatalf("stdin: got (%q, %q, %v)", m, src, err)
	}
	// No trailing newline is fine too.
	m, _, err = readMnemonic("", true, "", strings.NewReader(testMnemonic))
	if err != nil || m != testMnemonic {
		t.Fatalf("stdin without newline: got (%q, %v)", m, err)
	}
	if _, _, err := readMnemonic("", true, "", strings.NewReader("\n")); err == nil {
		t.Fatal("empty stdin line must error")
	}

	m, src, err = readMnemonic("", false, testMnemonic, strings.NewReader(""))
	if err != nil || m != testMnemonic || src != envOwnerMnemonic {
		t.Fatalf("env: got (%q, %q, %v)", m, src, err)
	}

	if _, _, err := readMnemonic(testMnemonic, true, "", strings.NewReader(testMnemonic)); err == nil {
		t.Fatal("argv + stdin must error")
	}
	if _, _, err := readMnemonic("", true, testMnemonic, strings.NewReader(testMnemonic)); err == nil {
		t.Fatal("stdin + env must error")
	}
}

func TestEnsureCanManageAccounts(t *testing.T) {
	if err := ensureCanManageAccounts(list.AclPermissionsAdmin, "-mnemonic (index 0)", "acc", "space"); err != nil {
		t.Errorf("admin should pass: %v", err)
	}
	if err := ensureCanManageAccounts(list.AclPermissionsOwner, "-mnemonic (index 0)", "acc", "space"); err != nil {
		t.Errorf("owner should pass: %v", err)
	}
	err := ensureCanManageAccounts(list.AclPermissionsReader, "-sign-key /x/sign.key", "accABC", "spaceXYZ")
	if err == nil {
		t.Fatal("reader must fail the owner check")
	}
	// The failure names the identity, the source it came from, and the level.
	for _, want := range []string{"accABC", "-sign-key /x/sign.key", "reader"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q should contain %q", err, want)
		}
	}
	if err := ensureCanManageAccounts(list.AclPermissionsWriter, "-mnemonic (index 0)", "acc", "space"); err == nil {
		t.Fatal("writer must fail the owner check")
	}
	if err := ensureCanManageAccounts(list.AclPermissionsNone, "-mnemonic (index 0)", "acc", "space"); err == nil {
		t.Fatal("none must fail the owner check")
	}
}

// A MATOU_IDENTITY_KEY-sealed sign.key (as PersistUserSignKey writes it once a
// key is registered for the data dir, #411) round-trips through
// loadSignKeyFile, and a sealed blob without the key errors clearly.
func TestLoadSignKeyFile_Sealed(t *testing.T) {
	dataDir := t.TempDir()
	key, _, err := resolveOwnerSignKey(testMnemonic, "", "", 0)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	raw := marshalKey(t, key.Marshall)

	// Seal exactly the way the app does: register the at-rest key for the data
	// dir and let PersistUserSignKey write the file.
	const material = "unit-test-identity-key"
	const aid = "EOwnerAID"
	anysync.RegisterDataDirKey(dataDir, []byte(material))
	t.Cleanup(func() { anysync.RegisterDataDirKey(dataDir, nil) })
	if err := anysync.PersistUserSignKey(dataDir, aid, key); err != nil {
		t.Fatalf("PersistUserSignKey: %v", err)
	}
	path := filepath.Join(dataDir, "users", aid, "sign.key")
	sealed, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !identity.IsSealed(sealed) {
		t.Fatal("PersistUserSignKey with a registered key should write a sealed file")
	}

	// Without the key material: actionable error, no cryptic unmarshal noise.
	t.Setenv(envIdentityKey, "")
	if _, err := loadSignKeyFile(path); err == nil || !strings.Contains(err.Error(), envIdentityKey) {
		t.Fatalf("sealed blob without key material should mention %s, got: %v", envIdentityKey, err)
	}

	// With the key material: decrypts to the original key.
	t.Setenv(envIdentityKey, material)
	loaded, err := loadSignKeyFile(path)
	if err != nil {
		t.Fatalf("loadSignKeyFile(sealed): %v", err)
	}
	if string(marshalKey(t, loaded.Marshall)) != string(raw) {
		t.Error("decrypted sign key != original")
	}

	// Wrong key material: decryption fails loudly.
	t.Setenv(envIdentityKey, "wrong-key")
	if _, err := loadSignKeyFile(path); err == nil {
		t.Fatal("wrong key material should fail decryption")
	}
}

// TestStagePeerKey proves the tool never hands the real install's peer.key to
// the SDK: a plaintext key is copied into the throwaway dir, a sealed key
// (#117/#411) is unsealed under MATOU_IDENTITY_KEY into the copy, and a sealed
// key without MATOU_IDENTITY_KEY, a missing file, or a non-key file are refused
// — in the SDK an unopenable device key is moved aside and replaced, which
// would silently rotate the owner's real install's device key.
func TestStagePeerKey(t *testing.T) {
	dir := t.TempDir()
	privKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		t.Fatal(err)
	}
	raw := marshalKey(t, privKey.Marshall)

	plain := filepath.Join(dir, "plain.key")
	if err := os.WriteFile(plain, raw, 0600); err != nil {
		t.Fatal(err)
	}
	tmp := t.TempDir()
	staged, err := stagePeerKey(plain, tmp)
	if err != nil {
		t.Fatalf("plaintext peer.key must be accepted: %v", err)
	}
	if filepath.Dir(staged) != tmp {
		t.Errorf("staged copy %s must live in the throwaway dir %s", staged, tmp)
	}
	if got, _ := os.ReadFile(staged); string(got) != string(raw) {
		t.Error("staged copy != original key bytes")
	}
	if got, _ := os.ReadFile(plain); string(got) != string(raw) {
		t.Error("original peer.key must be untouched")
	}

	sealedBytes, err := identity.Seal(raw, []byte("k"))
	if err != nil {
		t.Fatal(err)
	}
	sealed := filepath.Join(dir, "sealed.key")
	if err := os.WriteFile(sealed, sealedBytes, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envIdentityKey, "")
	if _, err := stagePeerKey(sealed, t.TempDir()); err == nil || !strings.Contains(err.Error(), envIdentityKey) {
		t.Errorf("sealed peer.key without %s must be refused with an actionable error, got %v", envIdentityKey, err)
	}
	t.Setenv(envIdentityKey, "k")
	staged, err = stagePeerKey(sealed, t.TempDir())
	if err != nil {
		t.Fatalf("sealed peer.key with %s set must be staged: %v", envIdentityKey, err)
	}
	if got, _ := os.ReadFile(staged); string(got) != string(raw) {
		t.Error("staged copy of sealed key != original key bytes")
	}
	if got, _ := os.ReadFile(sealed); string(got) != string(sealedBytes) {
		t.Error("original sealed peer.key must be untouched")
	}
	t.Setenv(envIdentityKey, "wrong")
	if _, err := stagePeerKey(sealed, t.TempDir()); err == nil {
		t.Error("sealed peer.key with the wrong key must be refused")
	}

	if _, err := stagePeerKey(filepath.Join(dir, "missing.key"), t.TempDir()); err == nil {
		t.Error("missing peer.key must be refused")
	}

	junk := filepath.Join(dir, "junk.key")
	if err := os.WriteFile(junk, []byte("not-a-key"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := stagePeerKey(junk, t.TempDir()); err == nil {
		t.Error("non-key file must be refused")
	}
}
