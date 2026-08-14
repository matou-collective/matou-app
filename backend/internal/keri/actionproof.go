package keri

import "strings"

// Shared canonical-digest proof format for high-stakes application actions
// (issue #20, "Enforcement 5/5"). This is the Go mirror of the frontend
// writer-side module `frontend/src/lib/keri/actionProof.ts`.
//
// any-sync signatures only prove *which sync account* wrote the bytes; they say
// nothing about organizational role, and any-sync has no revocation concept.
// The acting AID's signify-ts wallet signs a canonical digest of the action and
// embeds the detached signature + key-state reference in the object. Peers
// verify the signature against the AID's key state and that the AID holds a
// valid, TEL-unrevoked org credential.
//
// This file supplies ONLY the format: the envelope struct and the canonical
// digest builder, byte-identical to the TypeScript writer so a future verifier
// can reconstruct and check what the frontend signed. The actual peer-side
// verifier (CESR + ed25519 + KEL/TEL walk, decision (a) recorded 2026-08-13) is
// deferred to land with #19 and is NOT implemented here. The cross-language
// contract is locked by shared golden vectors — see actionproof_test.go and the
// frontend action-proof.test.ts.

// ProofVersion is stamped into every proof envelope. Bump on any format change.
const ProofVersion = "MATOU-PROOF-v1"

// Proof action identifiers. These are the string literals bound into the digest
// and must match the frontend ProofAction union exactly.
const (
	ActionContributionSignOff      = "contribution.sign_off"
	ActionContributionReward       = "contribution.reward"
	ActionPlanSignOff              = "plan.sign_off"
	ActionProjectCompletionApprove = "project.completion_approval"
	ActionMemberRoleChange         = "member.role_change"
)

// ActionProof is the proof envelope embedded on a high-stakes object. JSON tags
// are identical to the frontend ActionProof interface.
type ActionProof struct {
	V       string `json:"v"`                 // format version (ProofVersion)
	Action  string `json:"action"`            // which action this proof attests
	Subject string `json:"subject"`           // target id/said/AID
	Context string `json:"context,omitempty"` // optional extra digest term
	Dt      string `json:"dt"`                // ISO-8601 timestamp (part of digest)
	AID     string `json:"aid"`               // acting AID prefix (signer)
	KI      int    `json:"ki"`                // key index into signer key state 'k'
	S       string `json:"s"`                 // signer key-state sequence number (hex)
	Sig     string `json:"sig"`               // qb64 detached signature over CanonicalDigest
}

// CanonicalDigest rebuilds the exact string the frontend signed. It is
// reconstructed from the envelope's structured fields, never parsed by splitting
// on ':' — the timestamp contains colons, so a split would be ambiguous, while
// the join is deterministic. The context term is only included when non-empty,
// matching the frontend so a proof without context reproduces the three-part
// `action:subject:dt` form.
func CanonicalDigest(action, subject, dt, context string) string {
	if context != "" {
		return strings.Join([]string{action, subject, context, dt}, ":")
	}
	return strings.Join([]string{action, subject, dt}, ":")
}
