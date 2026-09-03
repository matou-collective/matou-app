package identity

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testMnemonic = "legal winner thank year wave sausage worth useful legal winner thank yellow"
const testAID = "EExampleAIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

// readIdentityFile returns the raw bytes persisted to {dir}/identity.json.
func readIdentityFile(t *testing.T, dir string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "identity.json"))
	if err != nil {
		t.Fatalf("reading identity file: %v", err)
	}
	return b
}

// assertNoPlaintextMnemonic fails if the raw bytes leak the mnemonic — the exact
// leak #117 describes (a grep of the data dir hitting three consecutive words).
func assertNoPlaintextMnemonic(t *testing.T, raw []byte) {
	t.Helper()
	if bytes.Contains(raw, []byte(testMnemonic)) {
		t.Fatal("identity file contains the full mnemonic in plaintext")
	}
	words := strings.Fields(testMnemonic)
	for i := 0; i+2 < len(words); i++ {
		tri := strings.Join(words[i:i+3], " ")
		if bytes.Contains(raw, []byte(tri)) {
			t.Fatalf("identity file leaks three consecutive mnemonic words: %q", tri)
		}
	}
}

// With an encryption key, the on-disk file must not leak the mnemonic and must
// round-trip back to the same value when reopened with the same key.
func TestEncryptedPersistNoPlaintextAndRoundTrip(t *testing.T) {
	dir := t.TempDir()
	key := []byte("keyring-supplied-secret-abc123")

	u := NewEncrypted(dir, key)
	if err := u.SetIdentity(testAID, testMnemonic); err != nil {
		t.Fatalf("SetIdentity: %v", err)
	}

	raw := readIdentityFile(t, dir)
	assertNoPlaintextMnemonic(t, raw)

	reopened := NewEncrypted(dir, key)
	if !reopened.IsConfigured() {
		t.Fatal("reopened identity should be configured")
	}
	if got := reopened.GetMnemonic(); got != testMnemonic {
		t.Fatalf("mnemonic round-trip failed: got %q", got)
	}
	if got := reopened.GetAID(); got != testAID {
		t.Fatalf("aid round-trip failed: got %q", got)
	}
}

// A different key must not decrypt the file: the identity loads as unconfigured
// rather than silently succeeding or panicking.
func TestWrongKeyDoesNotLoad(t *testing.T) {
	dir := t.TempDir()
	u := NewEncrypted(dir, []byte("correct-key"))
	if err := u.SetIdentity(testAID, testMnemonic); err != nil {
		t.Fatalf("SetIdentity: %v", err)
	}

	wrong := NewEncrypted(dir, []byte("wrong-key"))
	if wrong.IsConfigured() {
		t.Fatal("identity should not be configured under the wrong key")
	}
	if wrong.GetMnemonic() != "" {
		t.Fatal("mnemonic must not leak under the wrong key")
	}
}

// A legacy plaintext identity.json (written before this change) must be migrated
// to encrypted-at-rest transparently the first time it is opened with a key.
func TestPlaintextMigratedOnLoad(t *testing.T) {
	dir := t.TempDir()

	// Simulate a pre-existing plaintext identity (no key).
	plain := New(dir)
	if err := plain.SetIdentity(testAID, testMnemonic); err != nil {
		t.Fatalf("SetIdentity: %v", err)
	}
	if !bytes.Contains(readIdentityFile(t, dir), []byte(testMnemonic)) {
		t.Fatal("precondition: legacy file should be plaintext")
	}

	// Open with a key: it should load the value AND rewrite the file encrypted.
	key := []byte("keyring-supplied-secret")
	migrated := NewEncrypted(dir, key)
	if got := migrated.GetMnemonic(); got != testMnemonic {
		t.Fatalf("migrated mnemonic wrong: got %q", got)
	}
	assertNoPlaintextMnemonic(t, readIdentityFile(t, dir))

	// And it stays readable on the next open with the same key.
	again := NewEncrypted(dir, key)
	if again.GetMnemonic() != testMnemonic {
		t.Fatal("re-opened migrated identity lost its mnemonic")
	}
}

// Without a key, behaviour is byte-for-byte the legacy behaviour: plaintext JSON
// that round-trips. This guarantees dev/test/unwired-Electron are unaffected.
func TestNoKeyKeepsLegacyPlaintext(t *testing.T) {
	dir := t.TempDir()
	u := New(dir)
	if err := u.SetIdentity(testAID, testMnemonic); err != nil {
		t.Fatalf("SetIdentity: %v", err)
	}
	if !bytes.Contains(readIdentityFile(t, dir), []byte(testMnemonic)) {
		t.Fatal("no-key path should remain plaintext for backward compatibility")
	}
	if New(dir).GetMnemonic() != testMnemonic {
		t.Fatal("no-key round-trip failed")
	}
}
