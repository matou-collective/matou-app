// Package anysync provides any-sync integration for MATOU.
// proof_verifier.go implements the peer-side cryptographic verifier for
// KERI-anchored action proofs (GH#19 part 2). It replaces the interim,
// attacker-controlled ACL-join-metadata binding (part 1) as the legitimacy
// source for high-stakes, proof-backed transitions.
//
// The frontend (src/lib/keri/actionProof.ts — the single source of truth for
// the wire format) signs a canonical message with the acting steward's personal
// AID and embeds a Proof envelope on the object. This verifier reconstructs the
// identical byte string from the object's OWN authoritative fields (never a copy
// carried on the object, so a valid signature can't be lifted onto forged
// values) and verifies the signature against the signer AID's KEL signing key
// using the CESR + ed25519 primitives that landed with #18 (internal/auth).
//
// Because the signature covers action + subject(objectID) + space + value + dt,
// a forged high-stakes change written directly via the SDK by a writer-permission
// account cannot pass: the forger does not hold the steward's private key, so it
// cannot produce a valid Sig, and it cannot move a real steward's proof onto a
// different object (subject binding) or a different space (space binding).
//
// Determinism (GH#19 AC-2): a verdict is a pure function of the change's own
// synced data (the proof envelope) plus the signer AID's signing key. Key state
// is served from an in-memory snapshot refreshed off the state-reconstruction
// hot path (see internal/app), exactly like the role snapshot in part 1, so no
// network call happens under the tree lock. Honest peers converge as their
// snapshots converge; KEL key state is eventually consistent and append-only.
//
// KNOWN LIMITATIONS (documented follow-ups, see docs/RBAC.md):
//   - The proof envelope carries no KEL sequence number, so this verifies the
//     Cigar against the AID's *current* signing key(s) from the snapshot rather
//     than the key state "as of the proof's KEL sn". A key rotation therefore
//     invalidates the verifiability of proofs signed with the rotated-away key
//     (fail-closed, the safe direction). Binding to the exact signing-time key
//     state needs the wire format to anchor an sn — a frontend change tracked
//     separately.
//   - The signer's role is resolved from the synced CommunityProfile role
//     history keyed by the crypto-verified AID (RoleResolver.RolesForAIDAt).
//     Binding the role check to unrevoked org-credential (TEL) state from the
//     synced credential tree is the remaining refinement; the seam is in place.
package anysync

import (
	"strings"
	"sync"

	"github.com/matou-dao/backend/internal/auth"
	"github.com/matou-dao/backend/internal/contributions"
)

// proofVersion is the wire-format tag every action proof must carry. It mirrors
// PROOF_VERSION in frontend/src/lib/keri/actionProof.ts.
const proofVersion = "matou-proof/v1"

// KeyProvider yields the qb64 CESR signing key(s) used to verify an AID's
// action proofs. Returning ok=false means the AID's key state is not available
// from currently-synced/resolved state; the verifier then treats a present
// proof as unverifiable (fail-closed) rather than trusting it.
//
// Implementations must be safe for concurrent use and deterministic given the
// same snapshot: ValidateChange runs while an object-tree lock is held, so a
// provider must never trigger a synchronous network fetch here.
type KeyProvider interface {
	SigningKeys(aid string) (keys []string, ok bool)
}

// canonicalProofMessage rebuilds the exact byte string the frontend signs:
// the version tag followed by action, subject, space, value and dt, each on its
// own line. Mirrors buildProofMessage in actionProof.ts; keep the two in
// lockstep. None of the fields may contain a newline (the frontend enforces
// this at signing time), so the layout is unambiguous.
func canonicalProofMessage(action, subject, space, value, dt string) []byte {
	return []byte(strings.Join([]string{proofVersion, action, subject, space, value, dt}, "\n"))
}

// verifyActionProof cryptographically verifies a proof against an object's
// authoritative fields and returns the verified signer AID.
//
//   - action/subject/value are the object's authoritative values for this
//     transition (subject is the object id). The proof's copies of these must
//     match exactly, so the signed message is rebuilt from ground truth.
//   - space is the any-sync space the object lives in. When non-empty it must
//     equal the proof's space (anti-cross-space-replay). When empty the caller
//     could not determine the space (early-sync listener path); the check is
//     skipped and the proof's own space is used to rebuild the message — the
//     signature still binds the space, only the ground-truth comparison is
//     deferred to a path that knows the space.
//
// ok=false is returned with a human-readable reason for every failure mode:
// missing proof, envelope/field mismatch, unresolved key state, or a signature
// that does not verify. The reason is suitable for the rejection recorder.
func verifyActionProof(keys KeyProvider, action, subject, space, value string, p *contributions.Proof) (aid string, ok bool, reason string) {
	if p == nil {
		return "", false, "missing proof for high-stakes transition"
	}
	if p.V != proofVersion {
		return "", false, "proof: unsupported version"
	}
	if p.Action != action {
		return "", false, "proof: action does not match transition"
	}
	if p.Subject != subject {
		return "", false, "proof: subject does not match object id"
	}
	if space != "" && p.Space != space {
		return "", false, "proof: space does not match object space (cross-space replay)"
	}
	if p.Value != value {
		return "", false, "proof: value does not match asserted transition"
	}
	if p.AID == "" || p.Sig == "" || p.Dt == "" {
		return "", false, "proof: aid, sig and dt are required"
	}
	if keys == nil {
		return "", false, "proof: no key provider configured"
	}

	msgSpace := space
	if msgSpace == "" {
		msgSpace = p.Space
	}
	msg := canonicalProofMessage(action, subject, msgSpace, value, p.Dt)

	signingKeys, resolved := keys.SigningKeys(p.AID)
	if !resolved || len(signingKeys) == 0 {
		// Fail-closed: a proof is present but the signer's key state is not
		// available, so we cannot trust it. (Contrast part 1's fail-open on an
		// unresolved account — that path never had a signature to check.)
		return "", false, "proof: signer key state unavailable"
	}
	for _, k := range signingKeys {
		if valid, err := auth.VerifySignature(k, msg, p.Sig); err == nil && valid {
			return p.AID, true, ""
		}
	}
	return "", false, "proof: signature does not verify against signer key state"
}

// StaticKeyProvider serves signing keys from an in-memory map, replaced
// atomically by a background refresher (see internal/app) and used directly in
// tests. Safe for concurrent use.
type StaticKeyProvider struct {
	mu   sync.RWMutex
	keys map[string][]string
}

// NewStaticKeyProvider creates an empty provider. Until Replace/Set is called it
// resolves nothing (every proof is unverifiable → fail-closed).
func NewStaticKeyProvider() *StaticKeyProvider {
	return &StaticKeyProvider{keys: map[string][]string{}}
}

// Set records the signing key(s) for a single AID.
func (p *StaticKeyProvider) Set(aid string, keys ...string) {
	p.mu.Lock()
	if p.keys == nil {
		p.keys = map[string][]string{}
	}
	p.keys[aid] = append([]string(nil), keys...)
	p.mu.Unlock()
}

// Replace atomically swaps in a fresh AID → keys map.
func (p *StaticKeyProvider) Replace(keys map[string][]string) {
	if keys == nil {
		keys = map[string][]string{}
	}
	p.mu.Lock()
	p.keys = keys
	p.mu.Unlock()
}

// SigningKeys implements KeyProvider.
func (p *StaticKeyProvider) SigningKeys(aid string) ([]string, bool) {
	if aid == "" {
		return nil, false
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	keys, ok := p.keys[aid]
	if !ok || len(keys) == 0 {
		return nil, false
	}
	return keys, true
}
