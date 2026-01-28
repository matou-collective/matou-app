package anysync

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDeriveKeyFromMnemonic_Valid(t *testing.T) {
	// Valid 12-word BIP39 mnemonic
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

	key, err := DeriveKeyFromMnemonic(mnemonic, 0)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}

	if key == nil {
		t.Fatal("expected non-nil key")
	}

	// Check that we get a valid peer ID
	peerID := key.GetPublic().PeerId()
	if peerID == "" {
		t.Error("expected non-empty peer ID")
	}
}

func TestDeriveKeyFromMnemonic_InvalidMnemonic(t *testing.T) {
	// Invalid mnemonic
	mnemonic := "invalid words that are not a valid mnemonic phrase"

	_, err := DeriveKeyFromMnemonic(mnemonic, 0)
	if err == nil {
		t.Error("expected error for invalid mnemonic")
	}
}

func TestDeriveKeyFromMnemonic_Deterministic(t *testing.T) {
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

	// Derive key twice with same parameters
	key1, err := DeriveKeyFromMnemonic(mnemonic, 0)
	if err != nil {
		t.Fatalf("first derivation failed: %v", err)
	}

	key2, err := DeriveKeyFromMnemonic(mnemonic, 0)
	if err != nil {
		t.Fatalf("second derivation failed: %v", err)
	}

	// Keys should be identical
	peerID1 := key1.GetPublic().PeerId()
	peerID2 := key2.GetPublic().PeerId()

	if peerID1 != peerID2 {
		t.Errorf("expected same peer IDs, got %s and %s", peerID1, peerID2)
	}
}

func TestDeriveKeyFromMnemonic_DifferentIndex(t *testing.T) {
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

	key0, err := DeriveKeyFromMnemonic(mnemonic, 0)
	if err != nil {
		t.Fatalf("derivation at index 0 failed: %v", err)
	}

	key1, err := DeriveKeyFromMnemonic(mnemonic, 1)
	if err != nil {
		t.Fatalf("derivation at index 1 failed: %v", err)
	}

	// Different indices should produce different keys
	peerID0 := key0.GetPublic().PeerId()
	peerID1 := key1.GetPublic().PeerId()

	if peerID0 == peerID1 {
		t.Error("expected different peer IDs for different indices")
	}
}

func TestGetOrCreatePeerKey_CreatesNew(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "peer_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	keyPath := filepath.Join(tmpDir, "peer.key")

	// Key file shouldn't exist yet
	if _, err := os.Stat(keyPath); !os.IsNotExist(err) {
		t.Fatal("key file should not exist")
	}

	key, err := GetOrCreatePeerKey(keyPath)
	if err != nil {
		t.Fatalf("failed to create key: %v", err)
	}

	if key == nil {
		t.Fatal("expected non-nil key")
	}

	// Key file should now exist
	if _, err := os.Stat(keyPath); os.IsNotExist(err) {
		t.Error("key file should have been created")
	}
}

func TestGetOrCreatePeerKey_LoadsExisting(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "peer_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	keyPath := filepath.Join(tmpDir, "peer.key")

	// Create initial key
	key1, err := GetOrCreatePeerKey(keyPath)
	if err != nil {
		t.Fatalf("failed to create key: %v", err)
	}

	peerID1 := key1.GetPublic().PeerId()

	// Load existing key
	key2, err := GetOrCreatePeerKey(keyPath)
	if err != nil {
		t.Fatalf("failed to load key: %v", err)
	}

	peerID2 := key2.GetPublic().PeerId()

	// Should be the same key
	if peerID1 != peerID2 {
		t.Errorf("expected same peer ID after reload, got %s and %s", peerID1, peerID2)
	}
}

func TestNewPeerKeyManager_WithMnemonic(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "peer_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

	mgr, err := NewPeerKeyManager(&PeerKeyConfig{
		KeyPath:  filepath.Join(tmpDir, "peer.key"),
		Mnemonic: mnemonic,
		KeyIndex: 0,
	})
	if err != nil {
		t.Fatalf("failed to create manager: %v", err)
	}

	if mgr.GetPeerID() == "" {
		t.Error("expected non-empty peer ID")
	}
}

func TestNewPeerKeyManager_WithoutMnemonic(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "peer_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	mgr, err := NewPeerKeyManager(&PeerKeyConfig{
		KeyPath:  filepath.Join(tmpDir, "peer.key"),
		Mnemonic: "", // No mnemonic, should generate from file
	})
	if err != nil {
		t.Fatalf("failed to create manager: %v", err)
	}

	if mgr.GetPeerID() == "" {
		t.Error("expected non-empty peer ID")
	}
}

func TestPeerKeyManager_MapAIDToPeerID(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "peer_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	mgr, err := NewPeerKeyManager(&PeerKeyConfig{
		KeyPath: filepath.Join(tmpDir, "peer.key"),
	})
	if err != nil {
		t.Fatalf("failed to create manager: %v", err)
	}

	testAID := "EUser1234567890abcdef"
	testPeerID := "12D3KooWTestPeerID"

	// Map AID to peer ID
	mgr.MapAIDToPeerID(testAID, testPeerID)

	// Retrieve mapping
	retrieved, ok := mgr.GetPeerIDForAID(testAID)
	if !ok {
		t.Error("expected mapping to exist")
	}

	if retrieved != testPeerID {
		t.Errorf("expected %s, got %s", testPeerID, retrieved)
	}
}

func TestPeerKeyManager_GetPeerIDForAID_NotFound(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "peer_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	mgr, err := NewPeerKeyManager(&PeerKeyConfig{
		KeyPath: filepath.Join(tmpDir, "peer.key"),
	})
	if err != nil {
		t.Fatalf("failed to create manager: %v", err)
	}

	_, ok := mgr.GetPeerIDForAID("nonexistent-aid")
	if ok {
		t.Error("expected mapping to not exist")
	}
}

func TestGeneratePeerIDFromAID(t *testing.T) {
	aid1 := "EUser1_1234567890abcdef"
	aid2 := "EUser2_1234567890abcdef"

	peerID1 := GeneratePeerIDFromAID(aid1)
	peerID2 := GeneratePeerIDFromAID(aid2)

	// Different AIDs should produce different peer IDs
	if peerID1 == peerID2 {
		t.Error("expected different peer IDs for different AIDs")
	}

	// Same AID should produce same peer ID (deterministic)
	peerID1Again := GeneratePeerIDFromAID(aid1)
	if peerID1 != peerID1Again {
		t.Error("expected same peer ID for same AID")
	}

	// Should have matou prefix
	if len(peerID1) < 6 || peerID1[:6] != "matou-" {
		t.Errorf("expected matou- prefix, got %s", peerID1)
	}
}

func TestValidateMnemonic_Valid(t *testing.T) {
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

	err := ValidateMnemonic(mnemonic)
	if err != nil {
		t.Errorf("expected valid mnemonic, got error: %v", err)
	}
}

func TestValidateMnemonic_Invalid(t *testing.T) {
	mnemonic := "invalid words that are not a valid mnemonic"

	err := ValidateMnemonic(mnemonic)
	if err == nil {
		t.Error("expected error for invalid mnemonic")
	}
}

func TestPeerKeyManager_ExportPeerKey(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "peer_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	mgr, err := NewPeerKeyManager(&PeerKeyConfig{
		KeyPath: filepath.Join(tmpDir, "peer.key"),
	})
	if err != nil {
		t.Fatalf("failed to create manager: %v", err)
	}

	exported, err := mgr.ExportPeerKey()
	if err != nil {
		t.Fatalf("failed to export key: %v", err)
	}

	if len(exported) == 0 {
		t.Error("expected non-empty exported key")
	}
}

func TestPeerKeyManager_GetPeerInfo(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "peer_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	mgr, err := NewPeerKeyManager(&PeerKeyConfig{
		KeyPath: filepath.Join(tmpDir, "peer.key"),
	})
	if err != nil {
		t.Fatalf("failed to create manager: %v", err)
	}

	info, err := mgr.GetPeerInfo()
	if err != nil {
		t.Fatalf("failed to get peer info: %v", err)
	}

	if info.PeerID == "" {
		t.Error("expected non-empty peer ID in info")
	}

	if info.PublicKey == "" {
		t.Error("expected non-empty public key in info")
	}
}

func TestDeriveKeyForAID(t *testing.T) {
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	aid1 := "EUser1_1234567890abcdef"
	aid2 := "EUser2_1234567890abcdef"

	key1, err := DeriveKeyForAID(mnemonic, aid1)
	if err != nil {
		t.Fatalf("failed to derive key for AID 1: %v", err)
	}

	key2, err := DeriveKeyForAID(mnemonic, aid2)
	if err != nil {
		t.Fatalf("failed to derive key for AID 2: %v", err)
	}

	// Different AIDs should produce different keys
	peerID1 := key1.GetPublic().PeerId()
	peerID2 := key2.GetPublic().PeerId()

	if peerID1 == peerID2 {
		t.Error("expected different keys for different AIDs")
	}

	// Same AID should produce same key (deterministic)
	key1Again, err := DeriveKeyForAID(mnemonic, aid1)
	if err != nil {
		t.Fatalf("failed to derive key again: %v", err)
	}

	peerID1Again := key1Again.GetPublic().PeerId()
	if peerID1 != peerID1Again {
		t.Error("expected same key for same AID")
	}
}
