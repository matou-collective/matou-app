// Package anysync provides any-sync integration for MATOU.
// convention.go re-exports the community-space creation convention from the
// public github.com/matou-collective/matou-app/backend/communityspace module so
// there is a single implementation of the mnemonic-derived key sets, the ACL
// owner and the three-space orchestration — shared by this backend's org setup,
// the first-steward fallback and IDSS founding (issue #530).
//
// These are aliases and function values, not copies: anysync.DeriveSpaceKeySet
// IS communityspace.DeriveSpaceKeySet. Existing call sites keep using the
// anysync.* names.
package anysync

import "github.com/matou-collective/matou-app/backend/communityspace"

// SpaceKeySet is the four-key set required by any-sync for space creation.
type SpaceKeySet = communityspace.SpaceKeySet

// SpaceCreateResult contains the result of space creation.
type SpaceCreateResult = communityspace.SpaceCreateResult

var (
	// GenerateSpaceKeySet creates a new random SpaceKeySet.
	GenerateSpaceKeySet = communityspace.GenerateSpaceKeySet
	// DeriveSpaceKeySet derives a deterministic SpaceKeySet from a mnemonic and index.
	DeriveSpaceKeySet = communityspace.DeriveSpaceKeySet
	// DeriveKeyFromMnemonic derives an Ed25519 key at a mnemonic index.
	DeriveKeyFromMnemonic = communityspace.DeriveKeyFromMnemonic
	// ValidateMnemonic checks a mnemonic is valid for key derivation.
	ValidateMnemonic = communityspace.ValidateMnemonic
	// ComputeReplicationKey computes the FNV-64 replication key for a signing key.
	ComputeReplicationKey = communityspace.ComputeReplicationKey
)
