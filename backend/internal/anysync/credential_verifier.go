// Package anysync provides any-sync integration for MATOU.
// credential_verifier.go binds a proof-backed transition to the signer's org
// credential / TEL status (GH#19 part 3 / #112). Verifying an action proof
// authenticates the signer AID cryptographically; resolving the signer's role
// from the synced CommunityProfile role history says what role the profile
// *records*. But a role granted by an org credential that has since been
// REVOKED (TEL) may still show in a lagging profile role history. A revoked
// credential must be rejected regardless.
//
// CredentialVerifier is the seam: given a crypto-authenticated signer AID it
// returns the contribution roles granted by that AID's valid, UNREVOKED org
// credentials as of the change timestamp. The write-rule proof path then
// requires one of those roles to satisfy the transition (see write_rules.go),
// so a revoked role credential is rejected even when the synced profile role
// history has not yet caught up with the revocation.
//
// Determinism (GH#19 AC-2): resolution is a pure function of synced
// credential-tree + TEL state as of `at` (both append-only, eventually
// consistent), so honest peers agree, exactly like the role/key snapshots.
package anysync

import (
	"sync"

	"github.com/matou-dao/backend/internal/contributions"
)

// CredentialVerifier resolves the org roles a signer AID holds via valid,
// unrevoked credentials as of a change timestamp.
type CredentialVerifier interface {
	// UnrevokedRoles returns the contribution roles granted by aid's valid,
	// unrevoked org credentials as of unix time `at`. ok is false only when the
	// AID has no resolvable credential state in currently-synced data (the proof
	// path fails closed on !ok). A credential revoked as of `at` contributes no
	// role, so it cannot be rescued by a lagging profile role. reason is a
	// human-readable note for the rejection recorder.
	UnrevokedRoles(aid string, at int64) (roles []contributions.Role, ok bool, reason string)
}

// CredentialRecord is one org credential as reconstructed from the synced
// credential tree plus its TEL status. Role is the KERI credential role string
// (e.g. "Operations Steward"), mapped to contribution roles via
// contributions.MapKERIRole. Times are unix seconds: the credential grants its
// role for a change at time `at` when IssuedAt <= at and it is not revoked as of
// `at` (RevokedAt == 0 || at < RevokedAt).
type CredentialRecord struct {
	Role      string
	IssuedAt  int64
	RevokedAt int64
}

// CredentialSnapshot maps a recipient AID to its org role credentials.
type CredentialSnapshot struct {
	ByAID map[string][]CredentialRecord
}

// SnapshotCredentialVerifier is a concurrency-safe CredentialVerifier backed by
// a CredentialSnapshot replaced atomically by a background refresher (mirrors
// HistoryRoleResolver / StaticKeyProvider).
type SnapshotCredentialVerifier struct {
	mu   sync.RWMutex
	snap CredentialSnapshot
}

// NewSnapshotCredentialVerifier creates an empty verifier. Until Replace/Set is
// called every AID resolves ok=false (fail-closed for the proof path).
func NewSnapshotCredentialVerifier() *SnapshotCredentialVerifier {
	return &SnapshotCredentialVerifier{snap: CredentialSnapshot{ByAID: map[string][]CredentialRecord{}}}
}

// Replace atomically swaps in a fresh snapshot.
func (v *SnapshotCredentialVerifier) Replace(snap CredentialSnapshot) {
	if snap.ByAID == nil {
		snap.ByAID = map[string][]CredentialRecord{}
	}
	v.mu.Lock()
	v.snap = snap
	v.mu.Unlock()
}

// Set records the credential(s) for a single recipient AID.
func (v *SnapshotCredentialVerifier) Set(aid string, records ...CredentialRecord) {
	v.mu.Lock()
	if v.snap.ByAID == nil {
		v.snap.ByAID = map[string][]CredentialRecord{}
	}
	v.snap.ByAID[aid] = append([]CredentialRecord(nil), records...)
	v.mu.Unlock()
}

// UnrevokedRoles implements CredentialVerifier.
func (v *SnapshotCredentialVerifier) UnrevokedRoles(aid string, at int64) ([]contributions.Role, bool, string) {
	if aid == "" {
		return nil, false, "empty AID"
	}
	v.mu.RLock()
	records, known := v.snap.ByAID[aid]
	v.mu.RUnlock()
	if !known {
		return nil, false, "no org credential for signer AID"
	}

	seen := map[contributions.Role]bool{}
	var roles []contributions.Role
	revoked := 0
	for _, rec := range records {
		if rec.IssuedAt > at {
			continue // not yet issued as of the change
		}
		if rec.RevokedAt != 0 && at >= rec.RevokedAt {
			revoked++
			continue // revoked as of the change
		}
		for _, role := range contributions.MapKERIRole(rec.Role) {
			if !seen[role] {
				seen[role] = true
				roles = append(roles, role)
			}
		}
	}
	if len(roles) == 0 {
		if revoked > 0 {
			return nil, true, "org credential revoked"
		}
		return nil, true, "no active org credential grants a role"
	}
	return roles, true, ""
}
