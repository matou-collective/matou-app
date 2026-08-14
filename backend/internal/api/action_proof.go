package api

import (
	"encoding/json"
	"net/http"

	"github.com/matou-dao/backend/internal/keri"
)

// decodeActionProof extracts an optional KERI-verifiable proof (issue #20) from
// a request body of the form `{"proof": {...}}`.
//
// The proof is attached by the acting steward's signify-ts wallet on
// high-stakes actions (sign-off, reward, plan sign-off, project completion). It
// is optional and the body may be empty, so any decode error (including EOF on
// an empty body) yields a nil proof rather than failing the request. The proof
// is stored opaquely on the object — verification is the peer-side verifier's
// job (#19), not the writer path's.
func decodeActionProof(r *http.Request) *keri.ActionProof {
	if r.Body == nil {
		return nil
	}
	var body struct {
		Proof *keri.ActionProof `json:"proof"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	return body.Proof
}
