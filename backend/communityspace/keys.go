// Package communityspace is the single, importable home of the convention for
// creating a Matou community's any-sync spaces: the keys derived from the
// founder's mnemonic at space indexes 1 (community), 2 (read-only) and 3
// (admin), the header seeds, and the ACL owner.
//
// It is a public Go module named after the public GitHub mirror
// (github.com/matou-collective/matou-app/backend/communityspace) so that both
// this backend's own org setup and the IDSS founding tail can import and run
// the *same* code — the convention can never drift between the app and the
// platform that hosts it.
//
// The package has no dependency on the server's wiring: no HTTP layer, no store
// singleton, no identity-set side effects, and no process-wide config. Its only
// dependency is the any-sync client libraries. See CreateCommunitySpaces for the
// entry point.
package communityspace

import (
	"fmt"
	"hash/fnv"

	"github.com/anyproto/any-sync/util/crypto"
)

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
		SigningKey:  signingKey,
		MasterKey:   masterKey,
		ReadKey:     readKey,
		MetadataKey: metadataKey,
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
		SigningKey:  sigResult.Identity,
		MasterKey:   masterResult.Identity,
		ReadKey:     readKey,
		MetadataKey: metaResult.Identity,
	}, nil
}

// DeriveKeyFromMnemonic derives an Ed25519 private key from a BIP39 mnemonic.
// This uses the any-sync derivation path (m/44'/2046'/index'/0') which is
// compatible with Anytype's identity derivation. Index 0 is the account (ACL
// identity) key that owns the community's spaces.
func DeriveKeyFromMnemonic(mnemonic string, index uint32) (crypto.PrivKey, error) {
	m := crypto.Mnemonic(mnemonic)

	result, err := m.DeriveKeys(index)
	if err != nil {
		return nil, fmt.Errorf("deriving keys: %w", err)
	}

	// Use the Identity key (m/44'/2046'/index'/0')
	return result.Identity, nil
}

// ComputeReplicationKey computes a replication key from a signing key using
// FNV-64 hash, matching the any-sync SDK's algorithm for space-to-node
// assignment.
func ComputeReplicationKey(signingKey crypto.PrivKey) (uint64, error) {
	raw, err := signingKey.GetPublic().Raw()
	if err != nil {
		return 0, fmt.Errorf("getting public key bytes: %w", err)
	}
	h := fnv.New64()
	h.Write(raw)
	return h.Sum64(), nil
}

// ValidateMnemonic checks if a mnemonic is valid for key derivation.
func ValidateMnemonic(mnemonic string) error {
	m := crypto.Mnemonic(mnemonic)
	if _, err := m.Seed(); err != nil {
		return fmt.Errorf("invalid mnemonic: %w", err)
	}
	return nil
}
