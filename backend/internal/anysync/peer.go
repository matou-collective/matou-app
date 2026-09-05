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

// PeerKeyManager handles peer key generation, storage, and AID mapping
type PeerKeyManager struct {
	keyPath     string
	privKey     crypto.PrivKey
	peerID      string
	aidMappings map[string]string // AID -> PeerID
}

// PeerKeyConfig holds configuration for peer key management
type PeerKeyConfig struct {
	// KeyPath is the file path for storing the peer key (if not using mnemonic)
	KeyPath string
	// Mnemonic is the BIP39 mnemonic for deterministic key derivation
	Mnemonic string
	// KeyIndex is the derivation index (default 0)
	KeyIndex uint32
}

// NewPeerKeyManager creates a new peer key manager
func NewPeerKeyManager(cfg *PeerKeyConfig) (*PeerKeyManager, error) {
	mgr := &PeerKeyManager{
		keyPath:     cfg.KeyPath,
		aidMappings: make(map[string]string),
	}

	// Try mnemonic-based derivation first
	if cfg.Mnemonic != "" {
		privKey, err := DeriveKeyFromMnemonic(cfg.Mnemonic, cfg.KeyIndex)
		if err != nil {
			return nil, fmt.Errorf("deriving key from mnemonic: %w", err)
		}
		mgr.privKey = privKey
	} else {
		// Fall back to file-based key
		privKey, err := GetOrCreatePeerKey(cfg.KeyPath)
		if err != nil {
			return nil, fmt.Errorf("getting/creating peer key: %w", err)
		}
		mgr.privKey = privKey
	}

	// Derive peer ID from public key
	peerID := mgr.privKey.GetPublic().PeerId()
	mgr.peerID = peerID

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
	// Ensure directory exists
	dir := filepath.Dir(keyPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("creating key directory: %w", err)
	}

	// Try to load existing key. The peer key is sealed at rest under the
	// shell-supplied key when one is registered for this data directory; a
	// legacy plaintext key is accepted transparently and migrated to sealed
	// form below.
	if raw, err := os.ReadFile(keyPath); err == nil {
		data, wasSealed, oerr := openBytes(dir, raw)
		if oerr != nil {
			return nil, fmt.Errorf("opening peer key: %w", oerr)
		}
		privKey, err := crypto.UnmarshalEd25519PrivateKeyProto(data)
		if err != nil {
			return nil, fmt.Errorf("unmarshaling existing key: %w", err)
		}
		if shouldMigrate(dir, wasSealed) {
			if sealed, serr := sealBytes(dir, data); serr == nil {
				if werr := os.WriteFile(keyPath, sealed, 0600); werr != nil {
					fmt.Printf("Warning: failed to migrate peer.key to sealed form: %v\n", werr)
				}
			}
		}
		return privKey, nil
	}

	// Generate new key
	privKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		return nil, fmt.Errorf("generating key: %w", err)
	}

	// Save to file, sealed at rest when a key is registered.
	data, err := privKey.Marshall()
	if err != nil {
		return nil, fmt.Errorf("marshaling key: %w", err)
	}

	sealed, err := sealBytes(dir, data)
	if err != nil {
		return nil, fmt.Errorf("sealing key: %w", err)
	}

	if err := os.WriteFile(keyPath, sealed, 0600); err != nil {
		return nil, fmt.Errorf("saving key: %w", err)
	}

	return privKey, nil
}

// GetPrivKey returns the private key
func (m *PeerKeyManager) GetPrivKey() crypto.PrivKey {
	return m.privKey
}

// GetPeerID returns the peer ID string
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

// PersistUserPeerKey saves a user's peer private key for later use (e.g. JoinWithInvite).
// The key is stored at {dataDir}/users/{userAID}/peer.key.
func PersistUserPeerKey(dataDir, userAID string, key crypto.PrivKey) error {
	userDir := filepath.Join(dataDir, "users", userAID)
	if err := os.MkdirAll(userDir, 0700); err != nil {
		return fmt.Errorf("creating user directory: %w", err)
	}
	data, err := key.Marshall()
	if err != nil {
		return fmt.Errorf("marshaling peer key: %w", err)
	}
	sealed, err := sealBytes(dataDir, data)
	if err != nil {
		return fmt.Errorf("sealing user peer key: %w", err)
	}
	return os.WriteFile(filepath.Join(userDir, "peer.key"), sealed, 0600)
}

// LoadUserPeerKey loads a previously stored user peer key.
func LoadUserPeerKey(dataDir, userAID string) (crypto.PrivKey, error) {
	keyPath := filepath.Join(dataDir, "users", userAID, "peer.key")
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("reading user peer key: %w", err)
	}
	data, _, err := openBytes(dataDir, raw)
	if err != nil {
		return nil, fmt.Errorf("opening user peer key: %w", err)
	}
	return crypto.UnmarshalEd25519PrivateKeyProto(data)
}

// ExportPeerKey exports the peer key in a portable format
func (m *PeerKeyManager) ExportPeerKey() ([]byte, error) {
	return m.privKey.Marshall()
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
	pubKey := m.privKey.GetPublic()
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
