// Package anysync provides any-sync integration for MATOU.
// keys.go provides the full key set required by any-sync spaces:
// signing key (Ed25519), master key (Ed25519), read key (AES-256-GCM),
// and metadata key (Ed25519).
package anysync

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/anyproto/any-sync/util/crypto"
)

// parseJSONFile unmarshals JSON data into v
func parseJSONFile(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}

// SpaceKeySet, GenerateSpaceKeySet and DeriveSpaceKeySet now live in the public
// communityspace module and are re-exported here (see convention.go), so the
// derivation convention has a single implementation shared with IDSS founding
// (#530). The key persistence helpers below stay in this package because they
// touch the local store and the at-rest sealing, which are server concerns.

// spaceKeyBundle is the on-disk format for a persisted SpaceKeySet.
type spaceKeyBundle struct {
	SigningKey  []byte `json:"signingKey"`
	MasterKey   []byte `json:"masterKey"`
	ReadKey     []byte `json:"readKey"`
	MetadataKey []byte `json:"metadataKey"`
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

	data, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling key bundle: %w", err)
	}

	// Seal at rest under the shell-supplied key when one is registered for this
	// data directory; otherwise the bytes are written as legacy plaintext.
	sealed, err := sealBytes(dataDir, data)
	if err != nil {
		return fmt.Errorf("sealing key bundle: %w", err)
	}

	keyPath := filepath.Join(keysDir, spaceID+".keys")
	if err := os.WriteFile(keyPath, sealed, 0600); err != nil {
		return fmt.Errorf("writing key bundle: %w", err)
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

	raw, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("reading key file: %w", err)
	}

	// Open the sealed-at-rest form (or accept legacy plaintext). A missing key
	// or wrong key fails closed here rather than returning a corrupt bundle.
	data, wasSealed, err := openBytes(dataDir, raw)
	if err != nil {
		return nil, fmt.Errorf("opening key file: %w", err)
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

	keySet := &SpaceKeySet{
		SigningKey:  signingKey,
		MasterKey:   masterKey,
		ReadKey:     readKey,
		MetadataKey: metadataKey,
	}

	// Migrate a legacy plaintext bundle to sealed form the first time it is
	// opened with a key registered, mirroring the identity.json migration.
	if shouldMigrate(dataDir, wasSealed) {
		if err := PersistSpaceKeySet(dataDir, spaceID, keySet); err != nil {
			log.Printf("[anysync] Warning: failed to migrate %s.keys to sealed form: %v", spaceID, err)
		}
	}

	return keySet, nil
}
