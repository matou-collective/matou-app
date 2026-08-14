// backend/internal/contributions/proof.go
package contributions

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
