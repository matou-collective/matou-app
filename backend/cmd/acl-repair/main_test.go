package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anyproto/any-sync/commonspace/object/acl/list"

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

	resolved, desc, err := resolveOwnerSignKey(testMnemonic, "", 0)
	if err != nil {
		t.Fatalf("resolveOwnerSignKey(mnemonic): %v", err)
	}
	if !strings.Contains(desc, "-mnemonic") {
		t.Errorf("desc = %q, want it to mention -mnemonic", desc)
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
	fromMnemonic, _, err := resolveOwnerSignKey(testMnemonic, "", 0)
	if err != nil {
		t.Fatalf("resolveOwnerSignKey(mnemonic): %v", err)
	}
	const aid = "EOwnerAID"
	if err := anysync.PersistUserSignKey(dataDir, aid, fromMnemonic); err != nil {
		t.Fatalf("PersistUserSignKey: %v", err)
	}
	path := filepath.Join(dataDir, "users", aid, "sign.key")

	resolved, desc, err := resolveOwnerSignKey("", path, 0)
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

func TestResolveOwnerSignKey_Errors(t *testing.T) {
	// No owner-identity source: the actionable failure path.
	_, _, err := resolveOwnerSignKey("", "", 0)
	if err == nil {
		t.Fatal("expected error when no owner-identity source is given")
	}
	if !strings.Contains(err.Error(), "-mnemonic") || !strings.Contains(err.Error(), "-sign-key") {
		t.Errorf("error %q should name both -mnemonic and -sign-key", err)
	}

	// Both sources: ambiguous.
	if _, _, err := resolveOwnerSignKey(testMnemonic, "/tmp/whatever", 0); err == nil {
		t.Fatal("expected error when both -mnemonic and -sign-key are given")
	}

	// Invalid mnemonic.
	if _, _, err := resolveOwnerSignKey("not a valid mnemonic", "", 0); err == nil {
		t.Fatal("expected error for invalid mnemonic")
	}

	// Missing sign-key file.
	if _, _, err := resolveOwnerSignKey("", filepath.Join(t.TempDir(), "nope.key"), 0); err == nil {
		t.Fatal("expected error for missing sign-key file")
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
	if err := ensureCanManageAccounts(list.AclPermissionsNone, "-mnemonic (index 0)", "acc", "space"); err == nil {
		t.Fatal("none must fail the owner check")
	}
}

// A MATOU_IDENTITY_KEY-sealed sign.key round-trips through loadSignKeyFile
// (forward compat with #411), and a sealed blob without the key errors clearly.
func TestLoadSignKeyFile_Sealed(t *testing.T) {
	dataDir := t.TempDir()
	key, _, err := resolveOwnerSignKey(testMnemonic, "", 0)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	raw, err := key.Marshall()
	if err != nil {
		t.Fatalf("marshall: %v", err)
	}
	const material = "unit-test-identity-key"
	sealed := sealForTest(t, raw, []byte(material))
	path := filepath.Join(dataDir, "sign.key.sealed")
	if err := os.WriteFile(path, sealed, 0600); err != nil {
		t.Fatal(err)
	}

	if !isSealed(sealed) {
		t.Fatal("isSealed should recognise a sealed blob")
	}

	// Without the key material: actionable error, no cryptic unmarshal noise.
	t.Setenv("MATOU_IDENTITY_KEY", "")
	if _, err := loadSignKeyFile(path); err == nil || !strings.Contains(err.Error(), "MATOU_IDENTITY_KEY") {
		t.Fatalf("sealed blob without key material should mention MATOU_IDENTITY_KEY, got: %v", err)
	}

	// With the key material: decrypts to the original key.
	t.Setenv("MATOU_IDENTITY_KEY", material)
	loaded, err := loadSignKeyFile(path)
	if err != nil {
		t.Fatalf("loadSignKeyFile(sealed): %v", err)
	}
	if string(marshalKey(t, loaded.Marshall)) != string(raw) {
		t.Error("decrypted sign key != original")
	}

	// Wrong key material: decryption fails loudly.
	t.Setenv("MATOU_IDENTITY_KEY", "wrong-key")
	if _, err := loadSignKeyFile(path); err == nil {
		t.Fatal("wrong key material should fail decryption")
	}
}

// sealForTest mirrors internal/identity.encrypt so the test does not depend on
// an unexported helper.
func sealForTest(t *testing.T, plaintext, keyMaterial []byte) []byte {
	t.Helper()
	sum := sha256.Sum256(keyMaterial)
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		t.Fatal(err)
	}
	out := append([]byte{}, sealMagic...)
	out = append(out, nonce...)
	return gcm.Seal(out, nonce, plaintext, sealMagic)
}

// TestCheckPeerKeyReadable proves the tool refuses a peer.key that is sealed at
// rest (#117) instead of handing it to the SDK, where an unopenable device key
// is moved aside and replaced — which would silently rotate the owner's real
// install's device key from an ops tool run with the wrong flags.
func TestCheckPeerKeyReadable(t *testing.T) {
	dir := t.TempDir()

	plain := filepath.Join(dir, "plain.key")
	if err := os.WriteFile(plain, []byte("not-sealed-bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkPeerKeyReadable(plain); err != nil {
		t.Errorf("plaintext peer.key must be accepted: %v", err)
	}

	sealedBytes, err := identity.Seal([]byte("secret"), []byte("k"))
	if err != nil {
		t.Fatal(err)
	}
	sealed := filepath.Join(dir, "sealed.key")
	if err := os.WriteFile(sealed, sealedBytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err := checkPeerKeyReadable(sealed); err == nil {
		t.Error("sealed peer.key must be refused")
	}

	if err := checkPeerKeyReadable(filepath.Join(dir, "missing.key")); err == nil {
		t.Error("missing peer.key must be refused")
	}
}
