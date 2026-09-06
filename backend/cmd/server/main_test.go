package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/matou-dao/backend/internal/app"
	"github.com/matou-dao/backend/internal/identity"
)

// testMnemonic mirrors internal/identity's fixture. The assertion below is the
// #298 3-word-window check (issue #117): a grep of the data dir must not hit
// three consecutive mnemonic words.
const testMnemonic = "legal winner thank year wave sausage worth useful legal winner thank yellow"

// assertNoPlaintextMnemonic fails if raw leaks the mnemonic — the exact leak
// #117 describes (a grep of the data dir hitting three consecutive words).
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

// TestOptionsFromEnv_IdentityKeyReachesOptions proves the shell→backend seam
// #390 wires the Electron side of: MATOU_IDENTITY_KEY (what electron-main.ts
// passes at spawn) reaches Options.IdentityEncryptionKey, and an identity
// persisted under that key leaves no mnemonic on disk.
func TestOptionsFromEnv_IdentityKeyReachesOptions(t *testing.T) {
	const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	t.Setenv("MATOU_ENV", "") // force dev mode regardless of the runner's env
	t.Setenv("MATOU_IDENTITY_KEY", key)

	opts, err := app.OptionsFromEnv()
	if err != nil {
		t.Fatalf("OptionsFromEnv() error: %v", err)
	}
	if string(opts.IdentityEncryptionKey) != key {
		t.Fatalf("IdentityEncryptionKey = %q, want %q", opts.IdentityEncryptionKey, key)
	}

	// With the key set, a persisted identity.json must not leak the mnemonic.
	dir := t.TempDir()
	ui := identity.NewEncrypted(dir, opts.IdentityEncryptionKey)
	if err := ui.SetIdentity("EtestAID", testMnemonic); err != nil {
		t.Fatalf("SetIdentity: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "identity.json"))
	if err != nil {
		t.Fatalf("read identity.json: %v", err)
	}
	assertNoPlaintextMnemonic(t, raw)
}

// TestOptionsFromEnv_NoIdentityKeyLeavesPlaintext proves the empty-key legacy
// path: with MATOU_IDENTITY_KEY unset, IdentityEncryptionKey stays empty and
// identity.json is written in the legacy plaintext format (dev/test/CI and any
// not-yet-wired shell are unaffected).
func TestOptionsFromEnv_NoIdentityKeyLeavesPlaintext(t *testing.T) {
	t.Setenv("MATOU_ENV", "")
	t.Setenv("MATOU_IDENTITY_KEY", "") // empty == unset for os.Getenv

	opts, err := app.OptionsFromEnv()
	if err != nil {
		t.Fatalf("OptionsFromEnv() error: %v", err)
	}
	if len(opts.IdentityEncryptionKey) != 0 {
		t.Fatalf("IdentityEncryptionKey = %q, want empty", opts.IdentityEncryptionKey)
	}

	dir := t.TempDir()
	ui := identity.NewEncrypted(dir, opts.IdentityEncryptionKey)
	if err := ui.SetIdentity("EtestAID", testMnemonic); err != nil {
		t.Fatalf("SetIdentity: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "identity.json"))
	if err != nil {
		t.Fatalf("read identity.json: %v", err)
	}
	if !bytes.Contains(raw, []byte(testMnemonic)) {
		t.Fatal("no-key path should remain plaintext for backward compatibility")
	}
}
