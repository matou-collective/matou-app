package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/matou-dao/backend/internal/identity"
)

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
