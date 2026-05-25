package anysync

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/anyproto/any-sync/util/crypto"
)

func TestGenerateSpaceKeySet(t *testing.T) {
	keys, err := GenerateSpaceKeySet()
	if err != nil {
		t.Fatalf("GenerateSpaceKeySet failed: %v", err)
	}

	if keys.SigningKey == nil {
		t.Error("expected non-nil signing key")
	}
	if keys.MasterKey == nil {
		t.Error("expected non-nil master key")
	}
	if keys.ReadKey == nil {
		t.Error("expected non-nil read key")
	}
	if keys.MetadataKey == nil {
		t.Error("expected non-nil metadata key")
	}

	// Verify they are distinct Ed25519 keys
	sigPub := keys.SigningKey.GetPublic().PeerId()
	masterPub := keys.MasterKey.GetPublic().PeerId()
	metaPub := keys.MetadataKey.GetPublic().PeerId()

	if sigPub == masterPub {
		t.Error("signing key and master key should be different")
	}
	if sigPub == metaPub {
		t.Error("signing key and metadata key should be different")
	}
	if masterPub == metaPub {
		t.Error("master key and metadata key should be different")
	}

	// Verify read key can encrypt/decrypt
	plaintext := []byte("test credential data")
	ciphertext, err := keys.ReadKey.Encrypt(plaintext)
	if err != nil {
		t.Fatalf("encrypt failed: %v", err)
	}
	decrypted, err := keys.ReadKey.Decrypt(ciphertext)
	if err != nil {
		t.Fatalf("decrypt failed: %v", err)
	}
	if string(decrypted) != string(plaintext) {
		t.Errorf("decrypted text mismatch: got %q, want %q", decrypted, plaintext)
	}
}

func TestDeriveSpaceKeySet_Deterministic(t *testing.T) {
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

	keys1, err := DeriveSpaceKeySet(mnemonic, 0)
	if err != nil {
		t.Fatalf("first derivation failed: %v", err)
	}

	keys2, err := DeriveSpaceKeySet(mnemonic, 0)
	if err != nil {
		t.Fatalf("second derivation failed: %v", err)
	}

	// Signing keys should be identical
	sig1 := keys1.SigningKey.GetPublic().PeerId()
	sig2 := keys2.SigningKey.GetPublic().PeerId()
	if sig1 != sig2 {
		t.Errorf("signing keys should be deterministic: got %s and %s", sig1, sig2)
	}

	// Master keys should be identical
	master1 := keys1.MasterKey.GetPublic().PeerId()
	master2 := keys2.MasterKey.GetPublic().PeerId()
	if master1 != master2 {
		t.Errorf("master keys should be deterministic: got %s and %s", master1, master2)
	}

	// Metadata keys should be identical
	meta1 := keys1.MetadataKey.GetPublic().PeerId()
	meta2 := keys2.MetadataKey.GetPublic().PeerId()
	if meta1 != meta2 {
		t.Errorf("metadata keys should be deterministic: got %s and %s", meta1, meta2)
	}

	// Read keys are random, so they should differ
	raw1, _ := keys1.ReadKey.Raw()
	raw2, _ := keys2.ReadKey.Raw()
	if string(raw1) == string(raw2) {
		t.Log("note: read keys happen to match (unlikely but possible)")
	}
}

func TestDeriveSpaceKeySet_DifferentIndices(t *testing.T) {
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

	keys0, err := DeriveSpaceKeySet(mnemonic, 0)
	if err != nil {
		t.Fatalf("derivation at index 0 failed: %v", err)
	}

	keys1, err := DeriveSpaceKeySet(mnemonic, 1)
	if err != nil {
		t.Fatalf("derivation at index 1 failed: %v", err)
	}

	sig0 := keys0.SigningKey.GetPublic().PeerId()
	sig1 := keys1.SigningKey.GetPublic().PeerId()
	if sig0 == sig1 {
		t.Error("different space indices should produce different signing keys")
	}
}

func TestDeriveSpaceKeySet_InvalidMnemonic(t *testing.T) {
	_, err := DeriveSpaceKeySet("invalid words that are not valid", 0)
	if err == nil {
		t.Error("expected error for invalid mnemonic")
	}
}

func TestPersistAndLoadSpaceKeySet(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "keys_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Generate keys
	original, err := GenerateSpaceKeySet()
	if err != nil {
		t.Fatalf("GenerateSpaceKeySet failed: %v", err)
	}

	spaceID := "test-space-abc123"

	// Persist
	if err := PersistSpaceKeySet(tmpDir, spaceID, original); err != nil {
		t.Fatalf("PersistSpaceKeySet failed: %v", err)
	}

	// Load
	loaded, err := LoadSpaceKeySet(tmpDir, spaceID)
	if err != nil {
		t.Fatalf("LoadSpaceKeySet failed: %v", err)
	}

	// Compare signing keys
	origSig := original.SigningKey.GetPublic().PeerId()
	loadedSig := loaded.SigningKey.GetPublic().PeerId()
	if origSig != loadedSig {
		t.Errorf("signing key mismatch after round-trip: %s != %s", origSig, loadedSig)
	}

	// Compare master keys
	origMaster := original.MasterKey.GetPublic().PeerId()
	loadedMaster := loaded.MasterKey.GetPublic().PeerId()
	if origMaster != loadedMaster {
		t.Errorf("master key mismatch after round-trip: %s != %s", origMaster, loadedMaster)
	}

	// Compare metadata keys
	origMeta := original.MetadataKey.GetPublic().PeerId()
	loadedMeta := loaded.MetadataKey.GetPublic().PeerId()
	if origMeta != loadedMeta {
		t.Errorf("metadata key mismatch after round-trip: %s != %s", origMeta, loadedMeta)
	}

	// Compare read keys by encrypting/decrypting
	plaintext := []byte("round-trip test")
	ciphertext, err := original.ReadKey.Encrypt(plaintext)
	if err != nil {
		t.Fatalf("encrypt with original read key failed: %v", err)
	}
	decrypted, err := loaded.ReadKey.Decrypt(ciphertext)
	if err != nil {
		t.Fatalf("decrypt with loaded read key failed: %v", err)
	}
	if string(decrypted) != string(plaintext) {
		t.Errorf("read key round-trip failed: got %q, want %q", decrypted, plaintext)
	}
}

func TestLoadSpaceKeySet_NotFound(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "keys_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	_, err = LoadSpaceKeySet(tmpDir, "nonexistent-space")
	if err == nil {
		t.Error("expected error for non-existent key file")
	}
}

// TestLoadOrCreateSpaceKeySet_SelfHeal verifies the recovery path used by
// joiners whose JoinCommunity returned before PersistSpaceKeySet ran. When
// the key file is missing, a fresh bundle must be generated, persisted, and
// have its SigningKey bound to the caller-supplied peer key.
func TestLoadOrCreateSpaceKeySet_SelfHeal(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "selfheal_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	peerPriv, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		t.Fatalf("generating peer key: %v", err)
	}

	spaceID := "self-heal-space"
	keys, err := LoadOrCreateSpaceKeySet(tmpDir, spaceID, peerPriv)
	if err != nil {
		t.Fatalf("LoadOrCreateSpaceKeySet self-heal failed: %v", err)
	}
	if keys.SigningKey == nil || !keys.SigningKey.Equals(peerPriv) {
		t.Fatal("recovered SigningKey must equal supplied peer key")
	}

	// File now exists — second call should load same bundle (same signing key).
	keys2, err := LoadOrCreateSpaceKeySet(tmpDir, spaceID, peerPriv)
	if err != nil {
		t.Fatalf("second LoadOrCreateSpaceKeySet failed: %v", err)
	}
	if !keys.SigningKey.Equals(keys2.SigningKey) {
		t.Fatal("loaded signing key must equal originally persisted key")
	}
}

func TestLoadOrCreateSpaceKeySet_NoPeerKey(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "selfheal_nokey_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	_, err = LoadOrCreateSpaceKeySet(tmpDir, "any-space", nil)
	if err == nil {
		t.Fatal("expected error when key file is missing and no peer key provided")
	}
}

// TestMnemonicRecovery_PeerKeyAndSigningKeyMatch verifies the critical
// invariant of the org setup flow: the peer key derived from a mnemonic
// is the same key that ends up as the signing key in every space after
// the override (keys.SigningKey = peerKey) and a persist/load round-trip.
//
// This simulates the full sequence:
//  1. Derive peer key from mnemonic (index 0) — this is the SDK identity
//  2. For each space index (0-3), derive a SpaceKeySet
//  3. Override the signing key with the peer key (as HandleCreateCommunity does)
//  4. Persist the key set to disk
//  5. Load it back
//  6. Assert the loaded signing key matches the original peer key
//  7. Repeat derivation from scratch with the same mnemonic and assert identical results
func TestMnemonicRecovery_PeerKeyAndSigningKeyMatch(t *testing.T) {
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

	tmpDir, err := os.MkdirTemp("", "recovery_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Step 1: Derive the peer key (same as Reinitialize does)
	peerKey, err := DeriveKeyFromMnemonic(mnemonic, 0)
	if err != nil {
		t.Fatalf("DeriveKeyFromMnemonic failed: %v", err)
	}
	peerPubBytes, err := peerKey.GetPublic().Marshall()
	if err != nil {
		t.Fatalf("failed to marshal peer public key: %v", err)
	}
	peerPeerID := peerKey.GetPublic().PeerId()
	t.Logf("Peer key PeerID: %s", peerPeerID)

	// Step 2: Also create a PeerKeyManager with the mnemonic (simulates Reinitialize)
	mgr, err := NewPeerKeyManager(&PeerKeyConfig{
		KeyPath:  filepath.Join(tmpDir, "peer.key"),
		Mnemonic: mnemonic,
		KeyIndex: 0,
	})
	if err != nil {
		t.Fatalf("NewPeerKeyManager failed: %v", err)
	}

	// The PeerKeyManager's key must match the directly-derived peer key
	mgrPeerID := mgr.GetPeerID()
	if mgrPeerID != peerPeerID {
		t.Errorf("PeerKeyManager PeerID doesn't match DeriveKeyFromMnemonic:\n  manager: %s\n  direct:  %s", mgrPeerID, peerPeerID)
	}

	mgrPubBytes, err := mgr.GetPrivKey().GetPublic().Marshall()
	if err != nil {
		t.Fatalf("failed to marshal manager public key: %v", err)
	}
	if string(mgrPubBytes) != string(peerPubBytes) {
		t.Error("PeerKeyManager public key bytes don't match DeriveKeyFromMnemonic")
	}

	// Step 3: For each space index, derive keys, override signing key, persist, load, verify
	spaceNames := []string{"private", "community", "readonly", "admin"}
	for i := uint32(0); i < 4; i++ {
		spaceID := "test-space-" + spaceNames[i]
		t.Run(spaceNames[i], func(t *testing.T) {
			// Derive space key set
			keys, err := DeriveSpaceKeySet(mnemonic, i)
			if err != nil {
				t.Fatalf("DeriveSpaceKeySet(%d) failed: %v", i, err)
			}

			// Before override, the signing key is at derivation index i*4,
			// which differs from the peer key (index 0) for i > 0.
			origSigPeerID := keys.SigningKey.GetPublic().PeerId()
			if i == 0 {
				// Index 0: space signing key base = 0*4 = 0, same as peer key index 0.
				// They should be the same.
				if origSigPeerID != peerPeerID {
					t.Errorf("space index 0 signing key should equal peer key before override:\n  space: %s\n  peer:  %s", origSigPeerID, peerPeerID)
				}
			} else {
				// Index > 0: derived signing key should differ from peer key
				if origSigPeerID == peerPeerID {
					t.Errorf("space index %d signing key should differ from peer key before override", i)
				}
			}

			// Override signing key with peer key (as HandleCreateCommunity does)
			keys.SigningKey = peerKey

			// Verify the override took effect
			if keys.SigningKey.GetPublic().PeerId() != peerPeerID {
				t.Fatal("signing key override didn't take effect")
			}

			// Persist
			if err := PersistSpaceKeySet(tmpDir, spaceID, keys); err != nil {
				t.Fatalf("PersistSpaceKeySet failed: %v", err)
			}

			// Load
			loaded, err := LoadSpaceKeySet(tmpDir, spaceID)
			if err != nil {
				t.Fatalf("LoadSpaceKeySet failed: %v", err)
			}

			// The loaded signing key must match the peer key
			loadedSigPeerID := loaded.SigningKey.GetPublic().PeerId()
			if loadedSigPeerID != peerPeerID {
				t.Errorf("loaded signing key doesn't match peer key:\n  loaded: %s\n  peer:   %s", loadedSigPeerID, peerPeerID)
			}

			// Byte-level comparison of the public keys
			loadedSigPubBytes, _ := loaded.SigningKey.GetPublic().Marshall()
			if string(loadedSigPubBytes) != string(peerPubBytes) {
				t.Error("loaded signing key public bytes don't match peer key public bytes")
			}

			// Verify master and metadata keys survived the round-trip
			origMasterPeerID := keys.MasterKey.GetPublic().PeerId()
			loadedMasterPeerID := loaded.MasterKey.GetPublic().PeerId()
			if origMasterPeerID != loadedMasterPeerID {
				t.Errorf("master key changed after round-trip: %s != %s", origMasterPeerID, loadedMasterPeerID)
			}

			origMetaPeerID := keys.MetadataKey.GetPublic().PeerId()
			loadedMetaPeerID := loaded.MetadataKey.GetPublic().PeerId()
			if origMetaPeerID != loadedMetaPeerID {
				t.Errorf("metadata key changed after round-trip: %s != %s", origMetaPeerID, loadedMetaPeerID)
			}
		})
	}

	// Step 4: Re-derive everything from scratch with the same mnemonic.
	// This simulates recovery: only the mnemonic is known.
	t.Run("full_recovery_from_scratch", func(t *testing.T) {
		recoveredPeerKey, err := DeriveKeyFromMnemonic(mnemonic, 0)
		if err != nil {
			t.Fatalf("recovery DeriveKeyFromMnemonic failed: %v", err)
		}

		recoveredPeerID := recoveredPeerKey.GetPublic().PeerId()
		if recoveredPeerID != peerPeerID {
			t.Errorf("recovered peer key doesn't match original:\n  recovered: %s\n  original:  %s", recoveredPeerID, peerPeerID)
		}

		recoveredPubBytes, _ := recoveredPeerKey.GetPublic().Marshall()
		if string(recoveredPubBytes) != string(peerPubBytes) {
			t.Error("recovered peer key public bytes don't match original")
		}

		// Verify private key bytes also match (can sign the same content)
		origPrivBytes, _ := peerKey.Marshall()
		recoveredPrivBytes, _ := recoveredPeerKey.Marshall()
		if string(origPrivBytes) != string(recoveredPrivBytes) {
			t.Error("recovered peer key private bytes don't match original — signing would produce different results")
		}

		// Also verify that space master/metadata keys recover identically
		for i := uint32(0); i < 4; i++ {
			keys1, _ := DeriveSpaceKeySet(mnemonic, i)
			keys2, _ := DeriveSpaceKeySet(mnemonic, i)

			m1 := keys1.MasterKey.GetPublic().PeerId()
			m2 := keys2.MasterKey.GetPublic().PeerId()
			if m1 != m2 {
				t.Errorf("space %d: master keys not deterministic: %s != %s", i, m1, m2)
			}

			meta1 := keys1.MetadataKey.GetPublic().PeerId()
			meta2 := keys2.MetadataKey.GetPublic().PeerId()
			if meta1 != meta2 {
				t.Errorf("space %d: metadata keys not deterministic: %s != %s", i, meta1, meta2)
			}
		}
	})
}

// TestMnemonicRecovery_PeerKeyFileRoundTrip verifies that writing the
// mnemonic-derived peer key to a file and reading it back produces the
// exact same key. This is what Reinitialize does: overwrite peer.key
// then reload it in the new SDK instance.
func TestMnemonicRecovery_PeerKeyFileRoundTrip(t *testing.T) {
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

	tmpDir, err := os.MkdirTemp("", "peer_roundtrip_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Derive peer key
	derivedKey, err := DeriveKeyFromMnemonic(mnemonic, 0)
	if err != nil {
		t.Fatalf("DeriveKeyFromMnemonic failed: %v", err)
	}

	// Write to file (as Reinitialize does)
	keyPath := filepath.Join(tmpDir, "peer.key")
	keyData, err := derivedKey.Marshall()
	if err != nil {
		t.Fatalf("failed to marshal key: %v", err)
	}
	if err := os.WriteFile(keyPath, keyData, 0600); err != nil {
		t.Fatalf("failed to write key file: %v", err)
	}

	// Read it back (as the new SDK instance would)
	loadedKey, err := GetOrCreatePeerKey(keyPath)
	if err != nil {
		t.Fatalf("GetOrCreatePeerKey failed: %v", err)
	}

	// Compare peer IDs
	derivedPeerID := derivedKey.GetPublic().PeerId()
	loadedPeerID := loadedKey.GetPublic().PeerId()
	if derivedPeerID != loadedPeerID {
		t.Errorf("peer ID mismatch after file round-trip:\n  derived: %s\n  loaded:  %s", derivedPeerID, loadedPeerID)
	}

	// Compare private key bytes
	derivedBytes, _ := derivedKey.Marshall()
	loadedBytes, _ := loadedKey.Marshall()
	if string(derivedBytes) != string(loadedBytes) {
		t.Error("private key bytes changed after file round-trip")
	}

	// Derive again from mnemonic and confirm it still matches the loaded file
	reDerived, err := DeriveKeyFromMnemonic(mnemonic, 0)
	if err != nil {
		t.Fatalf("re-derivation failed: %v", err)
	}
	reDerivedPeerID := reDerived.GetPublic().PeerId()
	if reDerivedPeerID != loadedPeerID {
		t.Errorf("re-derived peer ID doesn't match loaded:\n  reDerived: %s\n  loaded:    %s", reDerivedPeerID, loadedPeerID)
	}
}

// TestMnemonicRecovery_UserPeerKeyPersistence verifies that PersistUserPeerKey
// and LoadUserPeerKey correctly round-trip the mnemonic-derived peer key.
func TestMnemonicRecovery_UserPeerKeyPersistence(t *testing.T) {
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	userAID := "EAdmin123456789"

	tmpDir, err := os.MkdirTemp("", "user_peer_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Derive peer key
	peerKey, err := DeriveKeyFromMnemonic(mnemonic, 0)
	if err != nil {
		t.Fatalf("DeriveKeyFromMnemonic failed: %v", err)
	}

	// Persist as user peer key
	if err := PersistUserPeerKey(tmpDir, userAID, peerKey); err != nil {
		t.Fatalf("PersistUserPeerKey failed: %v", err)
	}

	// Load it back
	loadedKey, err := LoadUserPeerKey(tmpDir, userAID)
	if err != nil {
		t.Fatalf("LoadUserPeerKey failed: %v", err)
	}

	// Compare
	origPeerID := peerKey.GetPublic().PeerId()
	loadedPeerID := loadedKey.GetPublic().PeerId()
	if origPeerID != loadedPeerID {
		t.Errorf("user peer key PeerID mismatch:\n  original: %s\n  loaded:   %s", origPeerID, loadedPeerID)
	}

	origPrivBytes, _ := peerKey.Marshall()
	loadedPrivBytes, _ := loadedKey.Marshall()
	if string(origPrivBytes) != string(loadedPrivBytes) {
		t.Error("user peer key private bytes changed after round-trip")
	}
}

// TestMnemonicRecovery_DifferentMnemonics verifies that different mnemonics
// produce completely different peer keys and space keys.
func TestMnemonicRecovery_DifferentMnemonics(t *testing.T) {
	mnemonic1 := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	mnemonic2 := "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"

	peer1, err := DeriveKeyFromMnemonic(mnemonic1, 0)
	if err != nil {
		t.Fatalf("derivation from mnemonic1 failed: %v", err)
	}

	peer2, err := DeriveKeyFromMnemonic(mnemonic2, 0)
	if err != nil {
		t.Fatalf("derivation from mnemonic2 failed: %v", err)
	}

	if peer1.GetPublic().PeerId() == peer2.GetPublic().PeerId() {
		t.Error("different mnemonics should produce different peer keys")
	}

	// Space keys should also differ
	space1, _ := DeriveSpaceKeySet(mnemonic1, 1)
	space2, _ := DeriveSpaceKeySet(mnemonic2, 1)

	if space1.MasterKey.GetPublic().PeerId() == space2.MasterKey.GetPublic().PeerId() {
		t.Error("different mnemonics should produce different space master keys")
	}
}
