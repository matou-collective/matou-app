// Package anysync provides any-sync integration for MATOU.
// keys.go provides the full key set required by any-sync spaces:
// signing key (Ed25519), master key (Ed25519), read key (AES-256-GCM),
// and metadata key (Ed25519).
package anysync

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/anyproto/any-sync/util/crypto"
)

// writeJSONFile marshals v to JSON and writes it to path
func writeJSONFile(path string, v interface{}) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling JSON: %w", err)
	}
	return os.WriteFile(path, data, 0644)
}

// parseJSONFile unmarshals JSON data into v
func parseJSONFile(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}

// SpaceKeySet holds the four keys required by any-sync for space creation.
type SpaceKeySet struct {
	// SigningKey signs the space header and ACL root (Ed25519)
	SigningKey crypto.PrivKey
	// MasterKey signs identity attestation (Ed25519)
	MasterKey crypto.PrivKey
	// ReadKey encrypts all tree content (AES-256-GCM symmetric)
	ReadKey crypto.SymKey
	// MetadataKey encrypts account metadata (Ed25519)
	MetadataKey crypto.PrivKey
}

// GenerateSpaceKeySet creates a new random SpaceKeySet with all four keys.
func GenerateSpaceKeySet() (*SpaceKeySet, error) {
	signingKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		return nil, fmt.Errorf("generating signing key: %w", err)
	}

	masterKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		return nil, fmt.Errorf("generating master key: %w", err)
	}

	readKey, err := crypto.NewRandomAES()
	if err != nil {
		return nil, fmt.Errorf("generating read key: %w", err)
	}

	metadataKey, _, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		return nil, fmt.Errorf("generating metadata key: %w", err)
	}

	return &SpaceKeySet{
		SigningKey:   signingKey,
		MasterKey:    masterKey,
		ReadKey:      readKey,
		MetadataKey:  metadataKey,
	}, nil
}

// DeriveSpaceKeySet derives a deterministic SpaceKeySet from a BIP39 mnemonic
// and a space index. Different key types use different derivation indices to
// ensure independence:
//   - signing key:  base + 0
//   - master key:   base + 1
//   - metadata key: base + 2
//   - read key:     random (symmetric keys can't be derived from Ed25519 path)
func DeriveSpaceKeySet(mnemonic string, spaceIndex uint32) (*SpaceKeySet, error) {
	m := crypto.Mnemonic(mnemonic)

	// Each space uses a base index = spaceIndex * 4
	base := spaceIndex * 4

	sigResult, err := m.DeriveKeys(base)
	if err != nil {
		return nil, fmt.Errorf("deriving signing key at index %d: %w", base, err)
	}

	masterResult, err := m.DeriveKeys(base + 1)
	if err != nil {
		return nil, fmt.Errorf("deriving master key at index %d: %w", base+1, err)
	}

	metaResult, err := m.DeriveKeys(base + 2)
	if err != nil {
		return nil, fmt.Errorf("deriving metadata key at index %d: %w", base+2, err)
	}

	// AES-256 symmetric keys cannot be derived via Ed25519 BIP paths.
	// Generate a random read key — it will be persisted alongside the space.
	readKey, err := crypto.NewRandomAES()
	if err != nil {
		return nil, fmt.Errorf("generating read key: %w", err)
	}

	return &SpaceKeySet{
		SigningKey:   sigResult.Identity,
		MasterKey:    masterResult.Identity,
		ReadKey:      readKey,
		MetadataKey:  metaResult.Identity,
	}, nil
}

// spaceKeyBundle is the on-disk format for a persisted SpaceKeySet.
type spaceKeyBundle struct {
	SigningKey   []byte `json:"signingKey"`
	MasterKey    []byte `json:"masterKey"`
	ReadKey      []byte `json:"readKey"`
	MetadataKey  []byte `json:"metadataKey"`
}

// PersistSpaceKeySet marshals each key and writes them to
// {dataDir}/keys/{spaceID}.keys
func PersistSpaceKeySet(dataDir, spaceID string, keys *SpaceKeySet) error {
	keysDir := filepath.Join(dataDir, "keys")
	if err := os.MkdirAll(keysDir, 0700); err != nil {
		return fmt.Errorf("creating keys directory: %w", err)
	}

	sigBytes, err := keys.SigningKey.Marshall()
	if err != nil {
		return fmt.Errorf("marshaling signing key: %w", err)
	}

	masterBytes, err := keys.MasterKey.Marshall()
	if err != nil {
		return fmt.Errorf("marshaling master key: %w", err)
	}

	readBytes, err := keys.ReadKey.Marshall()
	if err != nil {
		return fmt.Errorf("marshaling read key: %w", err)
	}

	metaBytes, err := keys.MetadataKey.Marshall()
	if err != nil {
		return fmt.Errorf("marshaling metadata key: %w", err)
	}

	bundle := spaceKeyBundle{
		SigningKey:  sigBytes,
		MasterKey:   masterBytes,
		ReadKey:     readBytes,
		MetadataKey: metaBytes,
	}

	keyPath := filepath.Join(keysDir, spaceID+".keys")
	if err := writeJSONFile(keyPath, bundle); err != nil {
		return fmt.Errorf("writing key bundle: %w", err)
	}

	// Restrict permissions
	if err := os.Chmod(keyPath, 0600); err != nil {
		return fmt.Errorf("setting key file permissions: %w", err)
	}

	return nil
}

// LoadOrCreateSpaceKeySet returns the persisted SpaceKeySet for the given
// space, or generates and persists a fresh one if the key file is missing.
//
// A missing key file happens when JoinCommunity returned before
// PersistSpaceKeySet ran (e.g. WaitForSync stalled). The user is still a
// valid Writer in the ACL, so we can self-heal by minting a new local key
// bundle whose SigningKey is bound to the peer key the ACL already knows.
//
// Callers should pass client.GetSigningKey() as signingKey — the same peer
// key that was registered when joining the space.
func LoadOrCreateSpaceKeySet(dataDir, spaceID string, signingKey crypto.PrivKey) (*SpaceKeySet, error) {
	keys, err := LoadSpaceKeySet(dataDir, spaceID)
	if err == nil {
		return keys, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	if signingKey == nil {
		return nil, fmt.Errorf("space keys missing for %s and no signing key available to recreate", spaceID)
	}

	fresh, err := GenerateSpaceKeySet()
	if err != nil {
		return nil, fmt.Errorf("generating recovery key set for %s: %w", spaceID, err)
	}
	fresh.SigningKey = signingKey

	if err := PersistSpaceKeySet(dataDir, spaceID, fresh); err != nil {
		return nil, fmt.Errorf("persisting recovery key set for %s: %w", spaceID, err)
	}

	return fresh, nil
}

// LoadSpaceKeySet reads and unmarshals a SpaceKeySet from
// {dataDir}/keys/{spaceID}.keys
func LoadSpaceKeySet(dataDir, spaceID string) (*SpaceKeySet, error) {
	keyPath := filepath.Join(dataDir, "keys", spaceID+".keys")

	data, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("reading key file: %w", err)
	}

	var bundle spaceKeyBundle
	if err := parseJSONFile(data, &bundle); err != nil {
		return nil, fmt.Errorf("parsing key bundle: %w", err)
	}

	signingKey, err := crypto.UnmarshalEd25519PrivateKeyProto(bundle.SigningKey)
	if err != nil {
		return nil, fmt.Errorf("unmarshaling signing key: %w", err)
	}

	masterKey, err := crypto.UnmarshalEd25519PrivateKeyProto(bundle.MasterKey)
	if err != nil {
		return nil, fmt.Errorf("unmarshaling master key: %w", err)
	}

	readKey, err := crypto.UnmarshallAESKeyProto(bundle.ReadKey)
	if err != nil {
		return nil, fmt.Errorf("unmarshaling read key: %w", err)
	}

	metadataKey, err := crypto.UnmarshalEd25519PrivateKeyProto(bundle.MetadataKey)
	if err != nil {
		return nil, fmt.Errorf("unmarshaling metadata key: %w", err)
	}

	return &SpaceKeySet{
		SigningKey:   signingKey,
		MasterKey:    masterKey,
		ReadKey:      readKey,
		MetadataKey:  metadataKey,
	}, nil
}
