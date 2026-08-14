package keri

import (
	"encoding/json"
	"testing"
)

// These golden vectors are shared, byte-for-byte, with the frontend test
// `frontend/tests/scripts/action-proof.test.ts`. If you change either side you
// MUST change both — the whole point of the format is that the signer
// (frontend) and the verifier (Go, deferred to #19) reconstruct the exact same
// digest. Keep the vectors identical.

func TestCanonicalDigest_ThreePartNoContext(t *testing.T) {
	got := CanonicalDigest(
		ActionContributionSignOff,
		"ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI",
		"2026-08-14T05:16:49.000Z",
		"",
	)
	want := "contribution.sign_off:ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI:2026-08-14T05:16:49.000Z"
	if got != want {
		t.Fatalf("CanonicalDigest mismatch:\n got: %q\nwant: %q", got, want)
	}
}

func TestCanonicalDigest_FourPartWithContext(t *testing.T) {
	got := CanonicalDigest(
		ActionMemberRoleChange,
		"EBmemberAID000000000000000000000000000000000",
		"2026-08-14T05:16:49.000Z",
		"Operations Steward",
	)
	want := "member.role_change:EBmemberAID000000000000000000000000000000000:Operations Steward:2026-08-14T05:16:49.000Z"
	if got != want {
		t.Fatalf("CanonicalDigest mismatch:\n got: %q\nwant: %q", got, want)
	}
}

// Empty context must reproduce exactly the three-part form (not an empty
// trailing segment) — the verifier reconstructs from the envelope's own fields,
// so this equivalence is load-bearing.
func TestCanonicalDigest_EmptyContextEqualsThreePart(t *testing.T) {
	withEmpty := CanonicalDigest(ActionContributionReward, "SUBJECT", "DT", "")
	threePart := "contribution.reward:SUBJECT:DT"
	if withEmpty != threePart {
		t.Fatalf("empty context should equal three-part form: got %q want %q", withEmpty, threePart)
	}
}

// The envelope must round-trip through JSON with the exact wire field names the
// frontend emits, and `context` must be omitted when empty.
func TestActionProof_JSONRoundTrip(t *testing.T) {
	raw := `{"v":"MATOU-PROOF-v1","action":"contribution.sign_off","subject":"ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI","dt":"2026-08-14T05:16:49.000Z","aid":"EBsignerAID00000000000000000000000000000000","ki":0,"s":"0","sig":"AAxSignatureQb64Placeholder"}`
	var p ActionProof
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if p.V != ProofVersion {
		t.Errorf("V = %q, want %q", p.V, ProofVersion)
	}
	if p.Action != ActionContributionSignOff {
		t.Errorf("Action = %q, want %q", p.Action, ActionContributionSignOff)
	}
	if p.Context != "" {
		t.Errorf("Context = %q, want empty", p.Context)
	}

	// Re-marshal: `context` (empty) must be omitted, matching the frontend which
	// only sets it when non-empty.
	out, err := json.Marshal(&p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("unmarshal re-marshaled: %v", err)
	}
	if _, present := m["context"]; present {
		t.Errorf("empty context should be omitted from JSON, got: %s", out)
	}
	for _, k := range []string{"v", "action", "subject", "dt", "aid", "ki", "s", "sig"} {
		if _, present := m[k]; !present {
			t.Errorf("expected key %q missing from JSON: %s", k, out)
		}
	}
}

func TestActionProof_JSONWithContext(t *testing.T) {
	p := ActionProof{
		V:       ProofVersion,
		Action:  ActionMemberRoleChange,
		Subject: "EBmemberAID000000000000000000000000000000000",
		Context: "Operations Steward",
		Dt:      "2026-08-14T05:16:49.000Z",
		AID:     "EBsignerAID00000000000000000000000000000000",
		KI:      0,
		S:       "0",
		Sig:     "AAxSignatureQb64Placeholder",
	}
	out, err := json.Marshal(&p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := m["context"]; !present {
		t.Errorf("non-empty context should be present in JSON, got: %s", out)
	}
}
