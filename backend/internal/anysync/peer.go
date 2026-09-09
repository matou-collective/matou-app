// Package anysync provides any-sync integration for MATOU.
// This file handles peer key management and AID-to-peerID mapping.
package anysync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"

	"github.com/anyproto/any-sync/util/crypto"
)

// PeerKeyManager holds the two distinct account keys and the AID mapping.
//
// The any-sync account model uses two independent keys (see accountdata.New):
//   - peerKey: the transport/device key. It must be unique per install so two
//     devices sharing one mnemonic present different peer ids; otherwise each
//     evicts the other's connection (net/pool AddPeer) and sync queue
//     (util/syncqueues). It is a random key persisted at {dataDir}/peer.key.
//   - signKey: the ACL identity key. It is mnemonic-derived and therefore the
//     same on every device the user owns, which is what the ACL records trust.
type PeerKeyManager struct {
	keyPath     string
	peerKey     crypto.PrivKey    // per-install transport/device key
	signKey     crypto.PrivKey    // mnemonic-derived ACL identity key
	peerID      string            // peer id of the device (peer) key
	aidMappings map[string]string // AID -> PeerID
}

// PeerKeyConfig holds configuration for peer key management
type PeerKeyConfig struct {
	// KeyPath is the file path for storing the per-install device (peer) key.
	KeyPath string
	// Mnemonic is the BIP39 mnemonic for deterministic sign-key derivation.
	Mnemonic string
	// KeyIndex is the derivation index (default 0)
	KeyIndex uint32
}

// NewPeerKeyManager creates a new peer key manager.
//
// The sign key is derived from the mnemonic when one is supplied (the ACL
// identity, stable across devices). The device/peer key is always a random
// per-install key persisted at KeyPath. When no mnemonic is supplied (dev/test
// without an identity) the device key doubles as the sign key.
func NewPeerKeyManager(cfg *PeerKeyConfig) (*PeerKeyManager, error) {
	mgr := &PeerKeyManager{
		keyPath:     cfg.KeyPath,
		aidMappings: make(map[string]string),
	}

	// Sign key: mnemonic-derived when available (the ACL identity).
	var signKey crypto.PrivKey
	if cfg.Mnemonic != "" {
		derived, err := DeriveKeyFromMnemonic(cfg.Mnemonic, cfg.KeyIndex)
		if err != nil {
			return nil, fmt.Errorf("deriving sign key from mnemonic: %w", err)
		}
		signKey = derived
	}

	// Device/peer key: a random per-install key. Migrates a legacy peer.key
	// that still holds the mnemonic-derived key (pre-#468 layout, where the
	// transport and ACL keys were the same) to a fresh random device key.
	peerKey, err := loadOrCreateDeviceKey(cfg.KeyPath, signKey)
	if err != nil {
		return nil, fmt.Errorf("getting/creating device peer key: %w", err)
	}
	mgr.peerKey = peerKey

	if signKey == nil {
		signKey = peerKey
	}
	mgr.signKey = signKey
	mgr.peerID = peerKey.GetPublic().PeerId()

	return mgr, nil
}

// DeriveKeyFromMnemonic derives an Ed25519 private key from a BIP39 mnemonic.
// This uses the any-sync derivation path (m/44'/2046'/index'/0') which is
// compatible with Anytype's identity derivation.
func DeriveKeyFromMnemonic(mnemonic string, index uint32) (crypto.PrivKey, error) {
	m := crypto.Mnemonic(mnemonic)

	result, err := m.DeriveKeys(index)
	if err != nil {
		return nil, fmt.Errorf("deriving keys: %w", err)
	}

	// Use the Identity key (m/44'/2046'/index'/0')
	return result.Identity, nil
}

// GetOrCreatePeerKey loads an existing peer key from file or generates a new one.
// The key is stored in a file for persistence across restarts.
func GetOrCreatePeerKey(keyPath string) (crypto.PrivKey, error) {
	// Try to load existing key
	if data, err := os.ReadFile(keyPath); err == nil {
		privKey, err := crypto.UnmarshalEd25519PrivateKeyProto(data)
		if err != nil {
			return nil, fmt.Errorf("unmarshaling existing key: %w", err)
		}
		return privKey, nil
	}

	return generateAndSaveKey(keyPath)
}

// generateAndSaveKey generates a fresh random Ed25519 key and writes it to
// keyPath (0600), creating the parent directory as needed.
func generateAndSaveKey(keyPath string) (crypto.PrivKey, error) {
	dir := filepath.Dir(keyPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("creating key directory: %w", err)
	}

	privKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		return nil, fmt.Errorf("generating key: %w", err)
	}

	data, err := privKey.Marshall()
	if err != nil {
		return nil, fmt.Errorf("marshaling key: %w", err)
	}

	if err := os.WriteFile(keyPath, data, 0600); err != nil {
		return nil, fmt.Errorf("saving key: %w", err)
	}

	return privKey, nil
}

// loadOrCreateDeviceKey returns the per-install device (peer) key at keyPath.
//
// It generates a fresh random key when none exists. When a key exists it is
// reused, except in the pre-#468 legacy case where {dataDir}/peer.key still
// holds the mnemonic-derived sign key: that key is the ACL identity and must
// never be reused as the transport key (two devices would collide), so a fresh
// random device key is minted and written over it. The sign key value the ACL
// already trusts is preserved separately as signKey by the caller.
func loadOrCreateDeviceKey(keyPath string, signKey crypto.PrivKey) (crypto.PrivKey, error) {
	data, err := os.ReadFile(keyPath)
	if err != nil {
		// No device key yet — mint a fresh random one.
		return generateAndSaveKey(keyPath)
	}

	existing, err := crypto.UnmarshalEd25519PrivateKeyProto(data)
	if err != nil {
		return nil, fmt.Errorf("unmarshaling existing device key: %w", err)
	}

	if signKey != nil && privKeysEqual(existing, signKey) {
		// Legacy layout: peer.key == the mnemonic-derived ACL key. Migrate.
		return generateAndSaveKey(keyPath)
	}

	return existing, nil
}

// privKeysEqual reports whether two private keys marshal to identical bytes.
func privKeysEqual(a, b crypto.PrivKey) bool {
	aBytes, err := a.Marshall()
	if err != nil {
		return false
	}
	bBytes, err := b.Marshall()
	if err != nil {
		return false
	}
	return string(aBytes) == string(bBytes)
}

// GetPeerKey returns the per-install device (transport) key.
func (m *PeerKeyManager) GetPeerKey() crypto.PrivKey {
	return m.peerKey
}

// GetSigningKey returns the mnemonic-derived ACL identity (sign) key.
func (m *PeerKeyManager) GetSigningKey() crypto.PrivKey {
	return m.signKey
}

// GetPeerID returns the peer ID string of the device (peer) key.
func (m *PeerKeyManager) GetPeerID() string {
	return m.peerID
}

// MapAIDToPeerID creates a mapping from a KERI AID to an any-sync peer ID.
// This is used to track which peer ID corresponds to which KERI identity.
func (m *PeerKeyManager) MapAIDToPeerID(aid string, peerID string) {
	m.aidMappings[aid] = peerID
}

// GetPeerIDForAID returns the peer ID mapped to a KERI AID
func (m *PeerKeyManager) GetPeerIDForAID(aid string) (string, bool) {
	peerID, ok := m.aidMappings[aid]
	return peerID, ok
}

// DeriveKeyForAID derives a deterministic key for a specific AID.
// This creates a unique key per AID that can be used for space ownership.
// The key is derived by hashing the mnemonic seed with the AID.
func DeriveKeyForAID(mnemonic string, aid string) (crypto.PrivKey, error) {
	// Get seed from mnemonic
	m := crypto.Mnemonic(mnemonic)
	seed, err := m.Seed()
	if err != nil {
		return nil, fmt.Errorf("getting seed: %w", err)
	}

	// Combine seed with AID for deterministic derivation
	combined := append(seed, []byte(aid)...)
	hash := sha256.Sum256(combined)

	// Generate key from hash
	privKey, err := crypto.NewSigningEd25519PrivKeyFromBytes(hash[:])
	if err != nil {
		// If 32 bytes isn't enough, extend it
		fullKey := make([]byte, 64)
		copy(fullKey[:32], hash[:])
		// Second hash for the second half
		hash2 := sha256.Sum256(append(hash[:], []byte("matou-extended")...))
		copy(fullKey[32:], hash2[:])
		privKey, err = crypto.NewSigningEd25519PrivKeyFromBytes(fullKey)
		if err != nil {
			return nil, fmt.Errorf("creating key from hash: %w", err)
		}
	}

	return privKey, nil
}

// ComputeReplicationKey computes a replication key from a signing key using
// FNV-64 hash, matching the any-sync SDK's algorithm for space-to-node assignment.
func ComputeReplicationKey(signingKey crypto.PrivKey) (uint64, error) {
	raw, err := signingKey.GetPublic().Raw()
	if err != nil {
		return 0, fmt.Errorf("getting public key bytes: %w", err)
	}
	h := fnv.New64()
	h.Write(raw)
	return h.Sum64(), nil
}

// AIDMapping represents a stored AID-to-PeerID mapping
type AIDMapping struct {
	AID       string `json:"aid"`
	PeerID    string `json:"peerId"`
	SpaceID   string `json:"spaceId,omitempty"`
	CreatedAt string `json:"createdAt"`
}

// AIDMappingStore interface for persisting AID mappings
type AIDMappingStore interface {
	SaveMapping(ctx context.Context, mapping *AIDMapping) error
	GetMapping(ctx context.Context, aid string) (*AIDMapping, error)
	ListMappings(ctx context.Context) ([]*AIDMapping, error)
}

// GeneratePeerIDFromAID generates a deterministic peer ID from an AID.
// This is useful for creating stable peer identities based on KERI AIDs
// without requiring mnemonic access.
func GeneratePeerIDFromAID(aid string) string {
	// Create deterministic identifier
	hash := sha256.Sum256([]byte("matou-peer:" + aid))
	return "matou-" + hex.EncodeToString(hash[:8])
}

// ValidateMnemonic checks if a mnemonic is valid for key derivation
func ValidateMnemonic(mnemonic string) error {
	m := crypto.Mnemonic(mnemonic)
	_, err := m.Seed()
	if err != nil {
		return fmt.Errorf("invalid mnemonic: %w", err)
	}
	return nil
}

// PersistUserSignKey saves a user's mnemonic-derived sign key (the ACL identity)
// for later use (e.g. JoinWithInvite and access verification).
// The key is stored at {dataDir}/users/{userAID}/sign.key.
//
// NOTE: this is the ACL identity (sign) key, NOT the per-install device key.
// handleVerifyAccess loads it and passes its public key to GetPermissions, so it
// must stay the mnemonic-derived value the ACL was built against.
func PersistUserSignKey(dataDir, userAID string, key crypto.PrivKey) error {
	userDir := filepath.Join(dataDir, "users", userAID)
	if err := os.MkdirAll(userDir, 0700); err != nil {
		return fmt.Errorf("creating user directory: %w", err)
	}
	data, err := key.Marshall()
	if err != nil {
		return fmt.Errorf("marshaling sign key: %w", err)
	}
	return os.WriteFile(filepath.Join(userDir, "sign.key"), data, 0600)
}

// LoadUserSignKey loads a previously stored user sign key (the ACL identity).
// It reads {dataDir}/users/{userAID}/sign.key, falling back to the pre-#468
// filename peer.key so existing installs keep resolving access.
func LoadUserSignKey(dataDir, userAID string) (crypto.PrivKey, error) {
	userDir := filepath.Join(dataDir, "users", userAID)
	data, err := os.ReadFile(filepath.Join(userDir, "sign.key"))
	if err != nil {
		// Fall back to the legacy filename (pre-#468).
		legacy, legacyErr := os.ReadFile(filepath.Join(userDir, "peer.key"))
		if legacyErr != nil {
			return nil, fmt.Errorf("reading user sign key: %w", err)
		}
		data = legacy
	}
	return crypto.UnmarshalEd25519PrivateKeyProto(data)
}

// ExportPeerKey exports the device (peer) key in a portable format
func (m *PeerKeyManager) ExportPeerKey() ([]byte, error) {
	return m.peerKey.Marshall()
}

// PeerInfo contains information about a peer for display/debugging
type PeerInfo struct {
	PeerID    string `json:"peerId"`
	PublicKey string `json:"publicKey"`
	Account   string `json:"account"`
	Network   string `json:"network"`
}

// GetPeerInfo returns information about the peer identity
func (m *PeerKeyManager) GetPeerInfo() (*PeerInfo, error) {
	pubKey := m.peerKey.GetPublic()
	raw, err := pubKey.Raw()
	if err != nil {
		return nil, err
	}

	return &PeerInfo{
		PeerID:    m.peerID,
		PublicKey: hex.EncodeToString(raw),
		Account:   pubKey.Account(),
		Network:   pubKey.Network(),
	}, nil
}

// MarshalJSON implements json.Marshaler for PeerKeyManager (for debugging)
func (m *PeerKeyManager) MarshalJSON() ([]byte, error) {
	info, err := m.GetPeerInfo()
	if err != nil {
		return nil, err
	}
	return json.Marshal(info)
}
