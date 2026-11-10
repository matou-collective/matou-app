package anysync

import (
	"errors"
	"testing"

	"github.com/anyproto/any-sync/util/crypto"

	"github.com/matou-dao/backend/internal/contributions"
)

// mustPubAccount returns a fresh ed25519 public key and its any-sync account
// string, so a fakeChange identity resolves through fakeResolver.
func mustPubAccount(t *testing.T) (crypto.PubKey, string) {
	t.Helper()
	_, pub, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		t.Fatal(err)
	}
	return pub, pub.Account()
}

// TestBuildState_SignedOffPlanLoadsFromSnapshotRoot is the #816 regression.
//
// any-sync reduces an object tree so its root becomes the latest snapshot. A
// read then begins iteration AT that snapshot with an empty `current`, so a
// high-stakes value the snapshot carries forward (here signed_off=true, set
// legitimately by a steward in a now-reduced-away change) is no longer
// recognised as a re-assertion. Before the fix the role-only write rule treated
// it as a fresh member-authored sign-off, rejected the whole snapshot and
// dropped every field in it, so the plan failed to build with
// ErrAllChangesRejected and never loaded.
func TestBuildState_SignedOffPlanLoadsFromSnapshotRoot(t *testing.T) {
	memberPub, memberAcct := mustPubAccount(t)
	resolver := fakeResolver{memberAcct: {contributions.RoleMember}}
	rec := &recordingRecorder{}
	v := NewWriteRuleValidator(resolver, nil, rec, false) // enforce OFF = prod default

	tree := &fakeTree{changes: []fakeChange{
		// Reduced-tree root: a snapshot carrying the signed-off plan forward,
		// authored by the plain member who happened to trigger it.
		{id: "snap", identity: memberPub, timestamp: 1000, snapshot: true, ops: []ChangeOp{
			setOp("id", "ip_00a9aa262ea998c7"),
			setOp("project_id", "proj_d93c5159884f915a"),
			rawOp("signed_off", `true`),
		}},
	}}

	state, err := BuildStateValidated(tree, "space-1", "ip_00a9aa262ea998c7", TypeImplementationPlan, v)
	if err != nil {
		t.Fatalf("signed-off plan must load from its snapshot root, got %v (rejections=%+v)", err, rec.rejections)
	}
	if string(state.Fields["signed_off"]) != "true" {
		t.Fatalf("expected signed_off=true carried forward, got %s", state.Fields["signed_off"])
	}
	if len(rec.rejections) != 0 {
		t.Fatalf("snapshot-root re-assertion must not be rejected, got %+v", rec.rejections)
	}
}

// TestBuildState_SnapshotRootReliefIsSurgical pins the security boundary the
// #816 relief must not cross: a member's snapshot that FLIPS a visible value to
// a NEW high-stakes one still has the old value present in `current`, so it is
// NOT the reduced-root carry-forward case and must still be rejected — the
// forged change is dropped and the prior legitimate state is preserved.
func TestBuildState_SnapshotRootReliefIsSurgical(t *testing.T) {
	stewardPub, stewardAcct := mustPubAccount(t)
	memberPub, memberAcct := mustPubAccount(t)
	resolver := fakeResolver{
		stewardAcct: contributions.MapKERIRole("Operations Steward"),
		memberAcct:  {contributions.RoleMember},
	}
	rec := &recordingRecorder{}
	v := NewWriteRuleValidator(resolver, nil, rec, false)

	tree := &fakeTree{changes: []fakeChange{
		// A legitimate assigned contribution (steward).
		{id: "c1", identity: stewardPub, timestamp: 1000, snapshot: true, ops: []ChangeOp{
			setOp("title", "Fix bug"), setOp("status", string(contributions.ContribAssigned)),
		}},
		// A member snapshot that forges a reward on top of the visible "assigned".
		{id: "c2", identity: memberPub, timestamp: 2000, snapshot: true, ops: []ChangeOp{
			setOp("title", "Fix bug"), setOp("status", string(contributions.ContribRewarded)),
		}},
	}}

	state, err := BuildStateValidated(tree, "space-1", "contrib-1", TypeContribution, v)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if got := jsonStringValue(state.Fields["status"]); got != string(contributions.ContribAssigned) {
		t.Fatalf("forged snapshot flip must be dropped, status=%q", got)
	}
	if len(rec.rejections) != 1 {
		t.Fatalf("expected the forged flip to be recorded once, got %+v", rec.rejections)
	}
	if errors.Is(err, ErrAllChangesRejected) {
		t.Fatal("unexpected")
	}
}

// TestRejectionInspector_SurfacesReasonPerRead pins the #816 observability fix:
// a validator whose recorder retains rejections can report, for a given object,
// the concrete rule/field/author/reason behind an ErrAllChangesRejected — so the
// read-path warning can log it on every read even though the recorder dedupes
// its own "[write-rules] REJECTED" line by change id.
func TestRejectionInspector_SurfacesReasonPerRead(t *testing.T) {
	memberPub, memberAcct := mustPubAccount(t)
	resolver := fakeResolver{memberAcct: {contributions.RoleMember}}
	rec := NewLoggingRejectionRecorder(10)
	v := NewWriteRuleValidator(resolver, nil, rec, false)

	// A genuine forged flip (old value visible) is recorded.
	tree := &fakeTree{changes: []fakeChange{
		{id: "c1", identity: memberPub, timestamp: 1000, snapshot: true, ops: []ChangeOp{
			setOp("status", string(contributions.ContribAssigned)),
		}},
		{id: "c2", identity: memberPub, timestamp: 2000, ops: []ChangeOp{
			setOp("status", string(contributions.ContribSignedOff)),
		}},
	}}
	if _, err := BuildStateValidated(tree, "space-1", "contrib-9", TypeContribution, v); err != nil {
		t.Fatalf("build: %v", err)
	}

	got := v.RejectionsFor("contrib-9")
	if len(got) != 1 || got[0].ChangeID != "c2" || got[0].Field != "status" {
		t.Fatalf("expected the forged sign-off recorded for contrib-9, got %+v", got)
	}
	if v.RejectionsFor("some-other-object") != nil {
		t.Fatal("must not return another object's rejections")
	}
	if desc := describeObjectRejections(v, "contrib-9"); desc == "" {
		t.Fatal("describeObjectRejections must render a non-empty diagnostic")
	}
}
