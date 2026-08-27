package anysync

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/util/crypto"

	"github.com/matou-dao/backend/internal/contributions"
)

// fakeResolver maps account → roles for tests (time-invariant). A missing
// account resolves ok=false.
type fakeResolver map[string][]contributions.Role

func (f fakeResolver) RolesForAuthorAt(account string, _ int64) ([]contributions.Role, bool) {
	roles, ok := f[account]
	return roles, ok
}

// RolesForAIDAt keys off the same map so proof-backed tests can register an AID
// directly (the AID is the map key in those tests).
func (f fakeResolver) RolesForAIDAt(aid string, _ int64) ([]contributions.Role, bool) {
	roles, ok := f[aid]
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

func rawOp(field, raw string) ChangeOp {
	return ChangeOp{Op: "set", Field: field, Value: json.RawMessage(raw)}
}

func TestValidateChange_ForgedSignOffRejected(t *testing.T) {
	resolver := fakeResolver{
		"acct-member": contributions.MapKERIRole("Member"), // baseline member
	}
	rec := &recordingRecorder{}
	v := NewWriteRuleValidator(resolver, nil, rec, false)

	ok := v.ValidateChange("", TypeContribution, "contrib-1", "chg-1", "acct-member", 0,
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
	v := NewWriteRuleValidator(resolver, nil, rec, false)

	ok := v.ValidateChange("", TypeContribution, "contrib-1", "chg-1", "acct-steward", 0,
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
	v := NewWriteRuleValidator(resolver, nil, &recordingRecorder{}, false)

	if v.ValidateChange("", TypeContribution, "c", "chg", "acct-projsteward", 0,
		[]ChangeOp{setOp("status", string(contributions.ContribRewarded))}, nil) {
		t.Error("project steward must not be able to reward")
	}
	if !v.ValidateChange("", TypeContribution, "c", "chg", "acct-projsteward", 0,
		[]ChangeOp{setOp("status", string(contributions.ContribSignedOff))}, nil) {
		t.Error("project steward must be able to sign off")
	}
}

func TestValidateChange_ProjectCompletion(t *testing.T) {
	resolver := fakeResolver{
		"acct-member": {contributions.RoleMember},
		"acct-lead":   {contributions.RoleProjectLead},
	}
	v := NewWriteRuleValidator(resolver, nil, &recordingRecorder{}, false)

	if v.ValidateChange("", TypeProject, "p", "chg", "acct-member", 0,
		[]ChangeOp{setOp("status", string(contributions.ProjectCompleted))}, nil) {
		t.Error("member must not complete a project")
	}
	if !v.ValidateChange("", TypeProject, "p", "chg", "acct-lead", 0,
		[]ChangeOp{setOp("status", string(contributions.ProjectPendingCompletion))}, nil) {
		t.Error("project lead must be able to submit completion")
	}
}

// Also-fix: plan and proposal sign-offs are guarded (issue names them).
func TestValidateChange_PlanSignOffGuarded(t *testing.T) {
	resolver := fakeResolver{
		"acct-member":  {contributions.RoleMember},
		"acct-steward": {contributions.RoleProjectSteward},
	}
	rec := &recordingRecorder{}
	v := NewWriteRuleValidator(resolver, nil, rec, false)

	if v.ValidateChange("", TypeImplementationPlan, "plan", "chg1", "acct-member", 0,
		[]ChangeOp{rawOp("signed_off", `true`)}, nil) {
		t.Error("member must not sign off an implementation plan")
	}
	if !v.ValidateChange("", TypeImplementationPlan, "plan", "chg2", "acct-steward", 0,
		[]ChangeOp{rawOp("signed_off", `true`)}, nil) {
		t.Error("project steward must be able to sign off a plan")
	}
	// Invalidation (signed_off → false) is not high-stakes: anyone editing a
	// milestone triggers it.
	if !v.ValidateChange("", TypeImplementationPlan, "plan", "chg3", "acct-member", 0,
		[]ChangeOp{rawOp("signed_off", `false`)}, map[string]json.RawMessage{"signed_off": json.RawMessage(`true`)}) {
		t.Error("clearing plan sign-off must be allowed for any member")
	}
	if len(rec.rejections) != 1 {
		t.Fatalf("expected exactly 1 rejection, got %d", len(rec.rejections))
	}
}

func TestValidateChange_ProposalSignOffGuarded(t *testing.T) {
	resolver := fakeResolver{
		"acct-member":  {contributions.RoleMember},
		"acct-steward": {contributions.RoleCommunitySteward},
	}
	v := NewWriteRuleValidator(resolver, nil, &recordingRecorder{}, false)

	if v.ValidateChange("", TypeProposal, "prop", "chg1", "acct-member", 0,
		[]ChangeOp{setOp("status", string(contributions.ProposalSignedOff))}, nil) {
		t.Error("member must not sign off a proposal")
	}
	if !v.ValidateChange("", TypeProposal, "prop", "chg2", "acct-steward", 0,
		[]ChangeOp{setOp("status", string(contributions.ProposalSignedOff))}, nil) {
		t.Error("community steward must be able to sign off a proposal")
	}
	if !v.ValidateChange("", TypeProposal, "prop", "chg3", "acct-member", 0,
		[]ChangeOp{setOp("status", string(contributions.ProposalSubmitted))}, nil) {
		t.Error("non-high-stakes proposal transition must be allowed")
	}
}

func TestValidateChange_RoleChangeRequiresAdmin(t *testing.T) {
	resolver := fakeResolver{
		"acct-member":  {contributions.RoleMember},
		"acct-founder": contributions.MapKERIRole("Founding Member"),
	}
	v := NewWriteRuleValidator(resolver, nil, &recordingRecorder{}, false)

	if v.ValidateChange("", "CommunityProfile", "cp", "chg", "acct-member", 0,
		[]ChangeOp{setOp("role", "Operations Steward")}, nil) {
		t.Error("member must not change a role")
	}
	if !v.ValidateChange("", "CommunityProfile", "cp", "chg", "acct-founder", 0,
		[]ChangeOp{setOp("role", "Operations Steward")}, nil) {
		t.Error("founding member must be able to change a role")
	}
}

func TestValidateChange_NonHighStakesValueAllowed(t *testing.T) {
	resolver := fakeResolver{"acct-member": {contributions.RoleMember}}
	v := NewWriteRuleValidator(resolver, nil, &recordingRecorder{}, false)

	if !v.ValidateChange("", TypeContribution, "c", "chg", "acct-member", 0,
		[]ChangeOp{setOp("status", string(contributions.ContribAssigned)), setOp("title", "x")}, nil) {
		t.Error("ordinary status transitions must be allowed")
	}
}

func TestValidateChange_UnresolvedAuthorFailsOpen(t *testing.T) {
	rec := &recordingRecorder{}
	v := NewWriteRuleValidator(fakeResolver{}, nil, rec, false)

	if !v.ValidateChange("", TypeContribution, "c", "chg", "acct-unknown", 0,
		[]ChangeOp{setOp("status", string(contributions.ContribSignedOff))}, nil) {
		t.Error("unresolvable author must fail open (documented gap; fail-closed lands with GH#20)")
	}
	if len(rec.rejections) != 0 {
		t.Error("fail-open must not record a rejection")
	}
}

func TestValidateChange_ReassertedValueAllowed(t *testing.T) {
	// A non-steward snapshot that carries forward an already-signed-off status
	// is not a new privileged action.
	resolver := fakeResolver{"acct-member": {contributions.RoleMember}}
	v := NewWriteRuleValidator(resolver, nil, &recordingRecorder{}, false)

	current := map[string]json.RawMessage{"status": json.RawMessage(`"signed_off"`)}
	if !v.ValidateChange("", TypeContribution, "c", "chg", "acct-member", 0,
		[]ChangeOp{setOp("status", "signed_off"), setOp("title", "renamed")}, current) {
		t.Error("re-asserting the current high-stakes value must be allowed")
	}
}

func TestValidateChange_UnguardedTypeAllowed(t *testing.T) {
	resolver := fakeResolver{"acct-member": {contributions.RoleMember}}
	v := NewWriteRuleValidator(resolver, nil, &recordingRecorder{}, false)

	if !v.ValidateChange("", "SharedProfile", "sp", "chg", "acct-member", 0,
		[]ChangeOp{setOp("status", "signed_off")}, nil) {
		t.Error("types without a rule must not be gated")
	}
}

// Blocking item 4: an empty object type must not silently bypass validation.
func TestBuildStateValidated_EmptyTypeFailsLoudly(t *testing.T) {
	v := NewWriteRuleValidator(fakeResolver{}, nil, &recordingRecorder{}, false)
	_, err := BuildStateValidated(nil, "", "obj-1", "", v)
	if !errors.Is(err, ErrUnknownObjectType) {
		t.Fatalf("expected ErrUnknownObjectType, got %v", err)
	}
	// Without a validator the legacy behaviour (type-less build) is preserved.
	tree := &fakeTree{changes: []fakeChange{{id: "c1", ops: []ChangeOp{setOp("a", "b")}}}}
	if _, err := BuildStateValidated(tree, "", "obj-1", "", nil); err != nil {
		t.Fatalf("nil validator must not require a type: %v", err)
	}
}

// --- fake tree for IterateRoot-driven tests (no infra) ---

type fakeChange struct {
	id        string
	identity  crypto.PubKey
	timestamp int64
	snapshot  bool
	ops       []ChangeOp
}

// fakeTree implements just enough of ReadableObjectTree for BuildStateValidated
// and RoleHistoryFromTree: IterateRoot feeds each change's JSON to convert and
// the resulting Change (with Model set) to iterate, in slice order.
type fakeTree struct {
	objecttree.ReadableObjectTree
	changes []fakeChange
}

func (f *fakeTree) IterateRoot(convert objecttree.ChangeConvertFunc, iterate objecttree.ChangeIterateFunc) error {
	for _, fc := range f.changes {
		data, _ := json.Marshal(ObjectChange{Ops: fc.ops})
		ch := &objecttree.Change{Id: fc.id, Identity: fc.identity, Timestamp: fc.timestamp, IsSnapshot: fc.snapshot}
		model, err := convert(ch, data)
		if err != nil {
			return err
		}
		ch.Model = model
		if !iterate(ch) {
			return nil
		}
	}
	return nil
}

func TestRoleHistoryFromTree_CollapsesReassertions(t *testing.T) {
	tree := &fakeTree{changes: []fakeChange{
		{id: "c1", timestamp: 100, snapshot: true, ops: []ChangeOp{setOp("aid", "E-alice"), setOp("role", "Member")}},
		{id: "c2", timestamp: 200, ops: []ChangeOp{setOp("displayName", "Alice")}},
		{id: "c3", timestamp: 300, ops: []ChangeOp{setOp("role", "Operations Steward")}},
		{id: "c4", timestamp: 400, snapshot: true, ops: []ChangeOp{setOp("aid", "E-alice"), setOp("role", "Operations Steward")}},
		{id: "c5", timestamp: 500, ops: []ChangeOp{setOp("role", "Member")}},
	}}
	aid, hist := RoleHistoryFromTree(tree)
	if aid != "E-alice" {
		t.Fatalf("aid: got %q", aid)
	}
	want := []RoleAt{{100, "Member"}, {300, "Operations Steward"}, {500, "Member"}}
	if len(hist) != len(want) {
		t.Fatalf("history: got %+v want %+v", hist, want)
	}
	for i := range want {
		if hist[i] != want[i] {
			t.Errorf("history[%d]: got %+v want %+v", i, hist[i], want[i])
		}
	}
}

// Blocking item 3: verdicts must be as-of the change, not current roles.
func TestHistoryRoleResolver_AsOfChange(t *testing.T) {
	r := NewHistoryRoleResolver()
	if _, ok := r.RolesForAuthorAt("acct", 0); ok {
		t.Fatal("empty resolver must resolve nothing")
	}
	r.Replace(RoleSnapshot{
		AccountAID: map[string]string{"acct-alice": "E-alice", "acct-bob": "E-bob"},
		History: map[string][]RoleAt{
			// deliberately unsorted: Replace must sort
			"E-alice": {{500, "Member"}, {100, "Member"}, {300, "Operations Steward"}},
		},
		AdminAIDs: map[string]bool{"E-bob": true},
	})

	has := func(roles []contributions.Role, want contributions.Role) bool {
		for _, r := range roles {
			if r == want {
				return true
			}
		}
		return false
	}

	// During stewardship (300..499) → steward.
	roles, ok := r.RolesForAuthorAt("acct-alice", 400)
	if !ok || !has(roles, contributions.RoleOperationsSteward) {
		t.Errorf("at 400 alice must be ops steward: %v ok=%v", roles, ok)
	}
	// After demotion (>=500) → member only; the earlier sign-off (400) above
	// is NOT retroactively rejected because it is evaluated at its own time.
	roles, ok = r.RolesForAuthorAt("acct-alice", 600)
	if !ok || has(roles, contributions.RoleOperationsSteward) {
		t.Errorf("at 600 alice must no longer be steward: %v", roles)
	}
	// Before the first recorded role → baseline member (backdating cannot
	// reach an unresolved/fail-open state for a bound account).
	roles, ok = r.RolesForAuthorAt("acct-alice", 50)
	if !ok || len(roles) != 1 || roles[0] != contributions.RoleMember {
		t.Errorf("at 50 alice must be baseline member: %v ok=%v", roles, ok)
	}
	// Exactly at the transition timestamp the new role applies.
	roles, _ = r.RolesForAuthorAt("acct-alice", 300)
	if !has(roles, contributions.RoleOperationsSteward) {
		t.Errorf("at 300 alice must be ops steward: %v", roles)
	}
	// Admin override is time-invariant.
	roles, ok = r.RolesForAuthorAt("acct-bob", 0)
	if !ok || !has(roles, contributions.RoleFoundingMember) {
		t.Errorf("org-config admin must be founding member: %v", roles)
	}
	// Unbound account → unresolved.
	if _, ok := r.RolesForAuthorAt("acct-mallory", 400); ok {
		t.Error("unbound account must resolve ok=false")
	}
	if _, ok := r.RolesForAuthorAt("", 400); ok {
		t.Error("empty account must resolve ok=false")
	}
}

// Determinism: same snapshot + same change → same verdict, and two resolvers
// built from the same data agree regardless of history insertion order.
func TestHistoryRoleResolver_Deterministic(t *testing.T) {
	a, b := NewHistoryRoleResolver(), NewHistoryRoleResolver()
	a.Replace(RoleSnapshot{AccountAID: map[string]string{"x": "E"}, History: map[string][]RoleAt{"E": {{10, "Member"}, {20, "Operations Steward"}}}})
	b.Replace(RoleSnapshot{AccountAID: map[string]string{"x": "E"}, History: map[string][]RoleAt{"E": {{20, "Operations Steward"}, {10, "Member"}}}})
	for _, ts := range []int64{5, 10, 15, 20, 25} {
		ra, oka := a.RolesForAuthorAt("x", ts)
		rb, okb := b.RolesForAuthorAt("x", ts)
		if oka != okb || len(ra) != len(rb) {
			t.Fatalf("resolvers disagree at %d: %v/%v vs %v/%v", ts, ra, oka, rb, okb)
		}
		for i := range ra {
			if ra[i] != rb[i] {
				t.Fatalf("resolvers disagree at %d: %v vs %v", ts, ra, rb)
			}
		}
	}
}

// Blocking item 1: first-bound wins, deterministically in record order.
func TestBindFirstClaims_FirstBoundWins(t *testing.T) {
	claims := []aidClaim{
		{"acct-alice", "E-alice"},
		{"acct-mallory", "E-alice"}, // hijack attempt: same AID, later record
		{"acct-alice", "E-other"},   // an account cannot rebind itself either
		{"acct-bob", "E-bob"},
		{"acct-gone", "E-gone"}, // no longer an active member
	}
	active := map[string]bool{"acct-alice": true, "acct-mallory": true, "acct-bob": true}
	got := bindFirstClaims(claims, active)
	want := map[string]string{"acct-alice": "E-alice", "acct-bob": "E-bob"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: got %q want %q", k, got[k], v)
		}
	}
	if _, bound := got["acct-mallory"]; bound {
		t.Error("second claimant of a bound AID must be rejected")
	}
	// Reversing the order flips the winner — proving the rule is record-order
	// driven, not identity-driven.
	rev := bindFirstClaims([]aidClaim{{"acct-mallory", "E-alice"}, {"acct-alice", "E-alice"}}, active)
	if rev["acct-mallory"] != "E-alice" || rev["acct-alice"] != "" {
		t.Errorf("record order must decide the winner: %v", rev)
	}
}

func TestExtractAIDFromMetadata(t *testing.T) {
	if got := extractAIDFromMetadata([]byte(`{"aid":"EABC","joinedAt":"2026-01-01T00:00:00Z"}`)); got != "EABC" {
		t.Errorf("got %q", got)
	}
	if got := extractAIDFromMetadata([]byte(`garbage`)); got != "" {
		t.Errorf("garbage must yield empty aid, got %q", got)
	}
}

// --- BuildStateValidated via applyChange (constructs real objecttree.Change
//     values, avoiding a full tree) ---

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
	v := NewWriteRuleValidator(resolver, nil, &recordingRecorder{}, false)

	state := &ObjectState{
		ObjectID:   "contrib-1",
		ObjectType: TypeContribution,
		Fields:     make(map[string]json.RawMessage),
	}

	// 1. steward creates + assigns (legit)
	state.applyChange("", changeFor("c1", stewardKey, true, setOp("status", "assigned")), &ObjectChange{Ops: []ChangeOp{setOp("status", "assigned")}}, v)
	// 2. member forges a sign-off (must be ignored)
	forge := &ObjectChange{Ops: []ChangeOp{setOp("status", "signed_off")}}
	state.applyChange("", changeFor("c2", memberKey, false, forge.Ops...), forge, v)

	if got := jsonStringValue(state.Fields["status"]); got != "assigned" {
		t.Fatalf("forged sign-off leaked into state: status=%q (want assigned)", got)
	}
	if state.Version != 1 {
		t.Fatalf("rejected change advanced version: got %d, want 1", state.Version)
	}

	// 3. the steward's own sign-off is applied
	legit := &ObjectChange{Ops: []ChangeOp{setOp("status", "signed_off")}}
	state.applyChange("", changeFor("c3", stewardKey, false, legit.Ops...), legit, v)
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
	state.applyChange("", changeFor("c1", memberKey, false, ops.Ops...), ops, nil)
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
	v := NewWriteRuleValidator(resolver, nil, &recordingRecorder{}, false)

	state := &ObjectState{ObjectID: "c", ObjectType: TypeContribution, Fields: make(map[string]json.RawMessage)}
	// steward signs off legitimately
	so := &ObjectChange{Ops: []ChangeOp{setOp("title", "Fix bug"), setOp("status", "signed_off")}}
	state.applyChange("", changeFor("c1", stewardKey, true, so.Ops...), so, v)

	// member issues a snapshot that flips status to rewarded while carrying the
	// title forward. The whole change is high-stakes (rewarded) → rejected → the
	// snapshot must not wipe or alter existing fields.
	snap := &ObjectChange{Ops: []ChangeOp{setOp("title", "Fix bug"), setOp("status", "rewarded")}}
	state.applyChange("", changeFor("c2", memberKey, true, snap.Ops...), snap, v)

	if got := jsonStringValue(state.Fields["status"]); got != "signed_off" {
		t.Fatalf("forged snapshot altered status: %q (want signed_off)", got)
	}
	if got := jsonStringValue(state.Fields["title"]); got != "Fix bug" {
		t.Fatalf("forged snapshot wiped title: %q", got)
	}
}

// Blocking item 2 (validator path): after a forged sign-off, the validated
// baseline still shows the pre-forgery status, so the steward's legitimate
// sign-off diffs to a real op instead of zero ops.
func TestValidatedBaseline_LegitTransitionStillDiffs(t *testing.T) {
	stewardKey, stewardAcct := mustAccount(t)
	memberKey, memberAcct := mustAccount(t)
	resolver := fakeResolver{
		stewardAcct: contributions.MapKERIRole("Operations Steward"),
		memberAcct:  contributions.MapKERIRole("Member"),
	}
	v := NewWriteRuleValidator(resolver, nil, &recordingRecorder{}, false)

	tree := &fakeTree{changes: []fakeChange{
		{id: "c1", identity: stewardKey, snapshot: true, ops: []ChangeOp{setOp("status", "assigned")}},
		{id: "c2", identity: memberKey, ops: []ChangeOp{setOp("status", "signed_off")}}, // forged
	}}

	raw, err := BuildState(tree, "contrib-1", TypeContribution)
	if err != nil {
		t.Fatal(err)
	}
	if DiffState(raw, map[string]json.RawMessage{"status": json.RawMessage(`"signed_off"`)}) != nil {
		t.Fatal("sanity: against the raw tree the legit sign-off diffs to nothing (the DoS)")
	}

	validated, err := BuildStateValidated(tree, "", "contrib-1", TypeContribution, v)
	if err != nil {
		t.Fatal(err)
	}
	if got := jsonStringValue(validated.Fields["status"]); got != "assigned" {
		t.Fatalf("validated baseline must exclude the forgery, got %q", got)
	}
	diff := DiffState(validated, map[string]json.RawMessage{"status": json.RawMessage(`"signed_off"`)})
	if diff == nil || len(diff.Ops) != 1 || diff.Ops[0].Field != "status" {
		t.Fatalf("legit sign-off must diff to a status op against the validated baseline, got %+v", diff)
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
	// An evicted change ID may be recorded again (its dedupe entry is gone).
	rec.RecordRejection(RejectedChange{ChangeID: "a"})
	if got := rec.Recent(); len(got) != 3 || got[2].ChangeID != "a" {
		t.Errorf("evicted id must be recordable again, got %+v", got)
	}
}

// Also-fix: state is rebuilt on every read, so the same forgery is re-rejected
// on every read; the recorder must dedupe by change ID.
func TestLoggingRejectionRecorder_DedupesByChangeID(t *testing.T) {
	rec := NewLoggingRejectionRecorder(10)
	for i := 0; i < 5; i++ {
		rec.RecordRejection(RejectedChange{ChangeID: "same", ObjectID: "o"})
	}
	rec.RecordRejection(RejectedChange{ChangeID: "other", ObjectID: "o"})
	if got := rec.Recent(); len(got) != 2 {
		t.Fatalf("expected 2 distinct rejections, got %d: %+v", len(got), got)
	}
}

// proofOp marshals a signed proof into the object field carrying it.
func proofOp(field string, p *contributions.Proof) ChangeOp {
	js, _ := json.Marshal(p)
	return rawOp(field, string(js))
}

// With proof enforcement ON, a valid signature by a credentialed steward AID is
// allowed; the same signature by a revoked (now member-only) AID is rejected;
// and an AID with no known role is rejected — exercising the crypto branch of
// ValidateChange end to end (forged-sig coverage is in proof_verifier_test.go
// and write_rules_tree_test.go).
func TestValidateChange_EnforceProofs(t *testing.T) {
	s := newSigner(t, "E-steward")
	keys := NewStaticKeyProvider()
	keys.Set(s.aid, s.verfer)
	proof := s.sign("contribution_signoff", "contrib-1", "space-community", "signed_off", "2026-08-27T00:00:00Z")

	ops := []ChangeOp{
		setOp("status", string(contributions.ContribSignedOff)),
		proofOp("sign_off_proof", proof),
	}

	// Valid: signer AID holds the ops-steward role.
	valid := NewWriteRuleValidator(
		fakeResolver{"E-steward": contributions.MapKERIRole("Operations Steward")}, keys, &recordingRecorder{}, true)
	if !valid.ValidateChange("space-community", TypeContribution, "contrib-1", "chg", "acct-x", 0, ops, nil) {
		t.Error("a valid steward-signed sign-off must be allowed under enforcement")
	}

	// Revoked: the signature is valid but the AID's credentialed role is now
	// member-only, so the transition is not permitted.
	rec := &recordingRecorder{}
	revoked := NewWriteRuleValidator(
		fakeResolver{"E-steward": contributions.MapKERIRole("Member")}, keys, rec, true)
	if revoked.ValidateChange("space-community", TypeContribution, "contrib-1", "chg", "acct-x", 0, ops, nil) {
		t.Error("a valid signature from a revoked/demoted AID must be rejected")
	}
	if len(rec.rejections) != 1 || rec.rejections[0].Reason != "signer role not permitted to set this value" {
		t.Errorf("unexpected rejection record: %+v", rec.rejections)
	}

	// Unknown AID: valid signature but no role resolvable → rejected.
	unknown := NewWriteRuleValidator(fakeResolver{}, keys, &recordingRecorder{}, true)
	if unknown.ValidateChange("space-community", TypeContribution, "contrib-1", "chg", "acct-x", 0, ops, nil) {
		t.Error("a signature from an AID with no known role must be rejected")
	}

	// Missing key state (empty provider) → fail closed even with a role.
	noKeys := NewWriteRuleValidator(
		fakeResolver{"E-steward": contributions.MapKERIRole("Operations Steward")}, NewStaticKeyProvider(), &recordingRecorder{}, true)
	if noKeys.ValidateChange("space-community", TypeContribution, "contrib-1", "chg", "acct-x", 0, ops, nil) {
		t.Error("an unresolved signer key must fail closed under enforcement")
	}
}

func TestIsGuardedObjectType(t *testing.T) {
	for _, typ := range []string{TypeContribution, TypeProject, TypeImplementationPlan, TypeProposal, "CommunityProfile"} {
		if !IsGuardedObjectType(typ) {
			t.Errorf("%s must be guarded", typ)
		}
	}
	if IsGuardedObjectType("SharedProfile") || IsGuardedObjectType("") {
		t.Error("unguarded types must report false")
	}
}
