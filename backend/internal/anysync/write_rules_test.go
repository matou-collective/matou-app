package anysync

import (
	"encoding/json"
	"testing"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/util/crypto"

	"github.com/matou-dao/backend/internal/contributions"
)

// fakeResolver maps account → roles for tests. A missing account resolves ok=false.
type fakeResolver map[string][]contributions.Role

func (f fakeResolver) RolesForAuthor(account string) ([]contributions.Role, bool) {
	roles, ok := f[account]
	return roles, ok
}

// recordingRecorder captures rejections for assertions.
type recordingRecorder struct{ rejections []RejectedChange }

func (r *recordingRecorder) RecordRejection(rc RejectedChange) {
	r.rejections = append(r.rejections, rc)
}

func setOp(field, value string) ChangeOp {
	return ChangeOp{Op: "set", Field: field, Value: json.RawMessage(`"` + value + `"`)}
}

func TestValidateChange_ForgedSignOffRejected(t *testing.T) {
	resolver := fakeResolver{
		"acct-member": contributions.MapKERIRole("Member"), // baseline member
	}
	rec := &recordingRecorder{}
	v := NewWriteRuleValidator(resolver, rec)

	ok := v.ValidateChange(TypeContribution, "contrib-1", "chg-1", "acct-member",
		[]ChangeOp{setOp("status", string(contributions.ContribSignedOff))}, nil)

	if ok {
		t.Fatal("expected a member-authored sign-off to be rejected")
	}
	if len(rec.rejections) != 1 {
		t.Fatalf("expected 1 recorded rejection, got %d", len(rec.rejections))
	}
	if rec.rejections[0].Field != "status" || rec.rejections[0].Value != "signed_off" {
		t.Errorf("unexpected rejection: %+v", rec.rejections[0])
	}
}

func TestValidateChange_LegitSignOffAllowed(t *testing.T) {
	resolver := fakeResolver{
		"acct-steward": contributions.MapKERIRole("Operations Steward"),
	}
	rec := &recordingRecorder{}
	v := NewWriteRuleValidator(resolver, rec)

	ok := v.ValidateChange(TypeContribution, "contrib-1", "chg-1", "acct-steward",
		[]ChangeOp{setOp("status", string(contributions.ContribSignedOff))}, nil)

	if !ok {
		t.Fatal("expected an operations-steward sign-off to be allowed")
	}
	if len(rec.rejections) != 0 {
		t.Fatalf("expected no rejections, got %d", len(rec.rejections))
	}
}

func TestValidateChange_RewardRequiresOpsSteward(t *testing.T) {
	// A project steward may sign off but not reward.
	resolver := fakeResolver{
		"acct-projsteward": {contributions.RoleProjectSteward},
	}
	v := NewWriteRuleValidator(resolver, &recordingRecorder{})

	if v.ValidateChange(TypeContribution, "c", "chg", "acct-projsteward",
		[]ChangeOp{setOp("status", string(contributions.ContribRewarded))}, nil) {
		t.Error("project steward must not be able to reward")
	}
	if !v.ValidateChange(TypeContribution, "c", "chg", "acct-projsteward",
		[]ChangeOp{setOp("status", string(contributions.ContribSignedOff))}, nil) {
		t.Error("project steward should be able to sign off")
	}
}

func TestValidateChange_ProjectCompletion(t *testing.T) {
	resolver := fakeResolver{
		"acct-member":  contributions.MapKERIRole("Member"),
		"acct-steward": contributions.MapKERIRole("Operations Steward"),
	}
	v := NewWriteRuleValidator(resolver, &recordingRecorder{})

	if v.ValidateChange(TypeProject, "p", "chg", "acct-member",
		[]ChangeOp{setOp("status", string(contributions.ProjectCompleted))}, nil) {
		t.Error("member must not complete a project")
	}
	if !v.ValidateChange(TypeProject, "p", "chg", "acct-steward",
		[]ChangeOp{setOp("status", string(contributions.ProjectCompleted))}, nil) {
		t.Error("operations steward should complete a project")
	}
}

func TestValidateChange_RoleChangeRequiresAdmin(t *testing.T) {
	resolver := fakeResolver{
		"acct-member":   contributions.MapKERIRole("Member"),
		"acct-founding": contributions.MapKERIRole("Founding Member"),
	}
	v := NewWriteRuleValidator(resolver, &recordingRecorder{})

	if v.ValidateChange("CommunityProfile", "cp", "chg", "acct-member",
		[]ChangeOp{setOp("role", "Founding Member")}, nil) {
		t.Error("member must not change a role")
	}
	if !v.ValidateChange("CommunityProfile", "cp", "chg", "acct-founding",
		[]ChangeOp{setOp("role", "Founding Member")}, nil) {
		t.Error("founding member should change a role")
	}
}

func TestValidateChange_NonHighStakesValueAllowed(t *testing.T) {
	// A member can move a contribution through ordinary statuses.
	resolver := fakeResolver{"acct-member": contributions.MapKERIRole("Member")}
	v := NewWriteRuleValidator(resolver, &recordingRecorder{})

	for _, status := range []string{"created", "assigned", "needs_review", "approved"} {
		if !v.ValidateChange(TypeContribution, "c", "chg", "acct-member",
			[]ChangeOp{setOp("status", status)}, nil) {
			t.Errorf("member should be allowed to set status %q", status)
		}
	}
}

func TestValidateChange_UnresolvedAuthorFailsOpen(t *testing.T) {
	resolver := fakeResolver{} // resolves nothing
	rec := &recordingRecorder{}
	v := NewWriteRuleValidator(resolver, rec)

	if !v.ValidateChange(TypeContribution, "c", "chg", "acct-unknown",
		[]ChangeOp{setOp("status", string(contributions.ContribSignedOff))}, nil) {
		t.Error("unresolved author should fail open (change allowed)")
	}
	if len(rec.rejections) != 0 {
		t.Error("fail-open must not record a rejection")
	}
}

func TestValidateChange_ReassertedValueAllowed(t *testing.T) {
	// A snapshot by a member carries forward a sign-off a steward already made.
	// Because the value is unchanged from current state, it is not a new
	// privileged transition and must be allowed.
	resolver := fakeResolver{"acct-member": contributions.MapKERIRole("Member")}
	rec := &recordingRecorder{}
	v := NewWriteRuleValidator(resolver, rec)

	current := map[string]json.RawMessage{"status": json.RawMessage(`"signed_off"`)}
	if !v.ValidateChange(TypeContribution, "c", "chg", "acct-member",
		[]ChangeOp{setOp("status", string(contributions.ContribSignedOff))}, current) {
		t.Error("re-asserting an unchanged high-stakes value must be allowed")
	}
	if len(rec.rejections) != 0 {
		t.Error("re-assertion must not be recorded as a rejection")
	}
}

func TestValidateChange_UnguardedTypeAllowed(t *testing.T) {
	resolver := fakeResolver{"acct-member": contributions.MapKERIRole("Member")}
	v := NewWriteRuleValidator(resolver, &recordingRecorder{})

	// ChatMessage has no write rule — anything goes.
	if !v.ValidateChange("ChatMessage", "m", "chg", "acct-member",
		[]ChangeOp{setOp("status", "signed_off")}, nil) {
		t.Error("types without a rule must be unrestricted")
	}
}

// --- BuildStateValidated integration (constructs real objecttree.Change values,
//     avoiding a full fake tree) ---

func mustAccount(t *testing.T) (crypto.PubKey, string) {
	t.Helper()
	_, pub, err := crypto.GenerateRandomEd25519KeyPair()
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	return pub, pub.Account()
}

func changeFor(id string, identity crypto.PubKey, snapshot bool, ops ...ChangeOp) *objecttree.Change {
	return &objecttree.Change{
		Id:         id,
		Identity:   identity,
		IsSnapshot: snapshot,
		Model:      &ObjectChange{Ops: ops},
	}
}

func TestApplyChange_ForgedSignOffExcludedFromState(t *testing.T) {
	stewardKey, stewardAcct := mustAccount(t)
	memberKey, memberAcct := mustAccount(t)

	resolver := fakeResolver{
		stewardAcct: contributions.MapKERIRole("Operations Steward"),
		memberAcct:  contributions.MapKERIRole("Member"),
	}
	v := NewWriteRuleValidator(resolver, &recordingRecorder{})

	state := &ObjectState{
		ObjectID:   "contrib-1",
		ObjectType: TypeContribution,
		Fields:     make(map[string]json.RawMessage),
	}

	// 1. steward creates + assigns (legit)
	state.applyChange(changeFor("c1", stewardKey, true, setOp("status", "assigned")), &ObjectChange{Ops: []ChangeOp{setOp("status", "assigned")}}, v)
	// 2. member forges a sign-off (must be ignored)
	forge := &ObjectChange{Ops: []ChangeOp{setOp("status", "signed_off")}}
	state.applyChange(changeFor("c2", memberKey, false, forge.Ops...), forge, v)

	if got := jsonStringValue(state.Fields["status"]); got != "assigned" {
		t.Fatalf("forged sign-off leaked into state: status=%q (want assigned)", got)
	}
	if state.Version != 1 {
		t.Fatalf("rejected change advanced version: got %d, want 1", state.Version)
	}

	// 3. the steward's own sign-off is applied
	legit := &ObjectChange{Ops: []ChangeOp{setOp("status", "signed_off")}}
	state.applyChange(changeFor("c3", stewardKey, false, legit.Ops...), legit, v)
	if got := jsonStringValue(state.Fields["status"]); got != "signed_off" {
		t.Fatalf("legit steward sign-off not applied: status=%q", got)
	}
	if state.Version != 2 {
		t.Fatalf("version after legit sign-off: got %d, want 2", state.Version)
	}
}

func TestApplyChange_NilValidatorUnchanged(t *testing.T) {
	memberKey, _ := mustAccount(t)
	state := &ObjectState{ObjectID: "c", ObjectType: TypeContribution, Fields: make(map[string]json.RawMessage)}
	ops := &ObjectChange{Ops: []ChangeOp{setOp("status", "signed_off")}}
	state.applyChange(changeFor("c1", memberKey, false, ops.Ops...), ops, nil)
	if jsonStringValue(state.Fields["status"]) != "signed_off" {
		t.Error("nil validator must apply every change unchanged")
	}
}

func TestApplyChange_ForgedSnapshotDoesNotWipeState(t *testing.T) {
	stewardKey, stewardAcct := mustAccount(t)
	memberKey, memberAcct := mustAccount(t)
	resolver := fakeResolver{
		stewardAcct: contributions.MapKERIRole("Operations Steward"),
		memberAcct:  contributions.MapKERIRole("Member"),
	}
	v := NewWriteRuleValidator(resolver, &recordingRecorder{})

	state := &ObjectState{ObjectID: "c", ObjectType: TypeContribution, Fields: make(map[string]json.RawMessage)}
	// steward signs off legitimately
	so := &ObjectChange{Ops: []ChangeOp{setOp("title", "Fix bug"), setOp("status", "signed_off")}}
	state.applyChange(changeFor("c1", stewardKey, true, so.Ops...), so, v)

	// member issues a snapshot that flips status to rewarded while carrying the
	// title forward. The whole change is high-stakes (rewarded) → rejected → the
	// snapshot must not wipe or alter existing fields.
	snap := &ObjectChange{Ops: []ChangeOp{setOp("title", "Fix bug"), setOp("status", "rewarded")}}
	state.applyChange(changeFor("c2", memberKey, true, snap.Ops...), snap, v)

	if got := jsonStringValue(state.Fields["status"]); got != "signed_off" {
		t.Fatalf("forged snapshot altered status: %q (want signed_off)", got)
	}
	if got := jsonStringValue(state.Fields["title"]); got != "Fix bug" {
		t.Fatalf("forged snapshot wiped title: %q", got)
	}
}

func TestLoggingRejectionRecorder_Bounded(t *testing.T) {
	rec := NewLoggingRejectionRecorder(3)
	for i := 0; i < 5; i++ {
		rec.RecordRejection(RejectedChange{ChangeID: string(rune('a' + i))})
	}
	recent := rec.Recent()
	if len(recent) != 3 {
		t.Fatalf("expected ring capped at 3, got %d", len(recent))
	}
	if recent[0].ChangeID != "c" || recent[2].ChangeID != "e" {
		t.Errorf("expected oldest-first [c d e], got %+v", recent)
	}
}

func TestCachedRoleResolver(t *testing.T) {
	r := NewCachedRoleResolver()
	if _, ok := r.RolesForAuthor("x"); ok {
		t.Error("empty resolver must return ok=false")
	}
	r.Replace(map[string][]contributions.Role{"x": {contributions.RoleFoundingMember}})
	roles, ok := r.RolesForAuthor("x")
	if !ok || len(roles) != 1 || roles[0] != contributions.RoleFoundingMember {
		t.Errorf("unexpected roles: %+v ok=%v", roles, ok)
	}
	if _, ok := r.RolesForAuthor(""); ok {
		t.Error("empty account must resolve ok=false")
	}
}
