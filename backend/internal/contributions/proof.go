// backend/internal/contributions/proof.go
package contributions

import "fmt"

// Proof is a KERI-anchored proof envelope attached to high-stakes actions
// (issue #20). The acting AID's signify-ts wallet signs a canonical message
// (see frontend src/lib/keri/actionProof.ts) and embeds this envelope on the
// object. Peer-side verification (issue #19) reconstructs the canonical message
// from the object's own fields and verifies Sig against the AID's KEL key state
// plus a valid, unrevoked org credential. The backend only persists it here.
//
// Canonical signed message (mirrored by the Go verifier in #19):
//
//	<v>\n<action>\n<subject>\n<value>\n<dt>
type Proof struct {
	V       string `json:"v"`       // format tag, e.g. "matou-proof/v1"
	Action  string `json:"action"`  // e.g. "contribution_signoff"
	Subject string `json:"subject"` // object id / SAID the action targets
	Value   string `json:"value"`   // asserted value, e.g. "signed_off"
	Dt      string `json:"dt"`      // RFC3339 timestamp bound into the signed message
	AID     string `json:"aid"`     // signer AID prefix
	Sig     string `json:"sig"`     // qb64 CESR signature over the canonical message
}

// ValidateConsistency rejects a proof whose envelope fields don't match the
// action it rides on. This is NOT cryptographic verification (that lands with
// #19) — just free string comparisons so a mismatched proof can't be persisted
// and synced as a permanently unverifiable record.
//
// actorAID is the authenticated caller (X-User-AID); the signer must be the
// actor. Pass "" to skip that check (e.g. no identity header on the route).
func (p *Proof) ValidateConsistency(action, subject, value, actorAID string) error {
	if p == nil {
		return nil
	}
	if p.V != "matou-proof/v1" {
		return fmt.Errorf("proof: unsupported version %q", p.V)
	}
	if p.Action != action {
		return fmt.Errorf("proof: action %q does not match %q", p.Action, action)
	}
	if p.Subject != subject {
		return fmt.Errorf("proof: subject %q does not match object %q", p.Subject, subject)
	}
	if p.Value != value {
		return fmt.Errorf("proof: value %q does not match asserted %q", p.Value, value)
	}
	if actorAID != "" && p.AID != actorAID {
		return fmt.Errorf("proof: signer AID does not match acting user")
	}
	if p.Sig == "" || p.Dt == "" {
		return fmt.Errorf("proof: sig and dt are required")
	}
	return nil
}
