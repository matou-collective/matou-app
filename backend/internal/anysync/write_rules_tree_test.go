package anysync

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	anystore "github.com/anyproto/any-store"
	"github.com/anyproto/any-sync/commonspace/headsync/headstorage"
	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/util/crypto"

	"github.com/matou-dao/backend/internal/contributions"
)

// This file is the integration-level test of GH#19 AC-1 as written: "a forged
// high-stakes change written by a peer with legitimate space Writer permission
// is excluded from every honest peer's derived state, and the legitimate
// transition still goes through". It uses a REAL any-sync object tree (real
// change builder, signature + ACL validation, encryption) backed by a real ACL
// with two writer accounts, and an in-memory anystore — no network, no infra.

// twoWriterACL builds an ACL where "a" is the owner (the steward) and "b" is an
// added writer (the member). Join metadata carries each account's claimed AID,
// exactly as HandleJoinCommunity writes it, so AccountAIDMap can be exercised.
func twoWriterACL(t *testing.T) (ownerAcl list.AclList, owner, member *list.TestAclState) {
	t.Helper()
	exec := list.NewAclExecutor("space-test")
	for _, cmd := range []string{
		`a.init::a`,
		`a.add::b,rw,{"aid":"E-member"}`,
		`a.add::c,rw,{"aid":"E-member"}`, // hijack attempt: second account claims b's AID
	} {
		if err := exec.Execute(cmd); err != nil {
			t.Fatalf("acl %s: %v", cmd, err)
		}
	}
	accounts := exec.ActualAccounts()
	return accounts["a"].Acl, accounts["a"], accounts["b"]
}

// newEncryptedTree creates a real, encrypted object tree rooted by owner with a
// TreeRootHeader for objectID/objectType, using an in-memory anystore.
func newEncryptedTree(t *testing.T, acl list.AclList, owner *list.TestAclState, objectID, objectType string) objecttree.ObjectTree {
	t.Helper()
	ctx := context.Background()
	header, _ := json.Marshal(TreeRootHeader{ObjectID: objectID, ObjectType: objectType})
	root, err := objecttree.CreateObjectTreeRoot(objecttree.ObjectTreeCreatePayload{
		PrivKey:       owner.Keys.SignKey,
		ChangeType:    ObjectChangeType,
		ChangePayload: header,
		SpaceId:       "space-test",
		IsEncrypted:   true,
		Timestamp:     1000,
	}, acl)
	if err != nil {
		t.Fatalf("root: %v", err)
	}
	db, err := anystore.Open(ctx, filepath.Join(t.TempDir(), "changes.db"), nil)
	if err != nil {
		t.Fatalf("anystore: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	hs, err := headstorage.New(ctx, db)
	if err != nil {
		t.Fatalf("headstorage: %v", err)
	}
	storage, err := objecttree.CreateStorage(ctx, root, hs, db)
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	tree, err := objecttree.BuildKeyFilterableObjectTree(storage, acl)
	if err != nil {
		t.Fatalf("tree: %v", err)
	}
	return tree
}

func addOps(t *testing.T, tree objecttree.ObjectTree, key crypto.PrivKey, ts int64, snapshot bool, ops ...ChangeOp) string {
	t.Helper()
	data, _ := json.Marshal(ObjectChange{Ops: ops})
	tree.Lock()
	defer tree.Unlock()
	res, err := tree.AddContent(context.Background(), objecttree.SignableChangeContent{
		Data:              data,
		Key:               key,
		IsSnapshot:        snapshot,
		ShouldBeEncrypted: true,
		Timestamp:         ts,
		DataType:          ObjectChangeType,
	})
	if err != nil {
		t.Fatalf("AddContent: %v", err)
	}
	return res.Heads[0]
}

func TestAC1_ForgedSignOffOnRealTree(t *testing.T) {
	acl, steward, member := twoWriterACL(t)
	stewardAcct := steward.Keys.SignKey.GetPublic().Account()
	memberAcct := member.Keys.SignKey.GetPublic().Account()

	// Blocking item 1: bind accounts → AIDs from the real ACL records, first
	// claim wins, hijacker "c" dropped. The owner joined via root (no metadata)
	// so it is not bound by the ACL; bind it explicitly as the steward.
	var mdKeys []crypto.PrivKey
	for _, k := range acl.AclState().Keys() {
		if k.MetadataPrivKey != nil {
			mdKeys = append(mdKeys, k.MetadataPrivKey)
		}
	}
	active := map[string]bool{}
	for _, a := range acl.AclState().CurrentAccounts() {
		active[a.PubKey.Account()] = true
	}
	bound := bindFirstClaims(aidClaimsInRecordOrder(acl, mdKeys), active)
	if bound[memberAcct] != "E-member" {
		t.Fatalf("member account must bind to E-member, got %v", bound)
	}
	if len(bound) != 1 {
		t.Fatalf("hijacker must be dropped, got %v", bound)
	}
	bound[stewardAcct] = "E-steward"

	resolver := NewHistoryRoleResolver()
	resolver.Replace(RoleSnapshot{
		AccountAID: bound,
		History: map[string][]RoleAt{
			"E-steward": {{Since: 500, Role: "Operations Steward"}},
			"E-member":  {{Since: 500, Role: "Member"}},
		},
	})
	recorder := NewLoggingRejectionRecorder(10)
	validator := NewWriteRuleValidator(resolver, recorder)

	tree := newEncryptedTree(t, acl, steward, "contrib-1", TypeContribution)

	// Steward creates and assigns the contribution (legit).
	addOps(t, tree, steward.Keys.SignKey, 2000, true, setOp("title", "Fix bug"), setOp("status", "assigned"))
	// Member (legit Writer on the space) FORGES a sign-off directly into the tree.
	forgedID := addOps(t, tree, member.Keys.SignKey, 3000, false, setOp("status", "signed_off"))

	// AC-1: every honest peer excludes the forged change from derived state.
	tree.Lock()
	state, err := BuildStateValidated(tree, "contrib-1", TypeContribution, validator)
	tree.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if got := jsonStringValue(state.Fields["status"]); got != "assigned" {
		t.Fatalf("forged sign-off entered state: status=%q", got)
	}
	if got := jsonStringValue(state.Fields["title"]); got != "Fix bug" {
		t.Fatalf("unrelated field lost: title=%q", got)
	}
	rej := recorder.Recent()
	if len(rej) != 1 || rej[0].ChangeID != forgedID || rej[0].Author != memberAcct {
		t.Fatalf("expected the forged change to be recorded once, got %+v", rej)
	}

	// The raw (unvalidated) tree DOES contain the forgery — the SDK accepted it.
	tree.Lock()
	raw, _ := BuildState(tree, "contrib-1", TypeContribution)
	tree.Unlock()
	if jsonStringValue(raw.Fields["status"]) != "signed_off" {
		t.Fatal("sanity: SDK should have accepted the forged change into the tree")
	}

	// Blocking item 2: the steward's legitimate sign-off must still be
	// writable. Diff against the validated baseline (as UpdateObject now does).
	want := map[string]json.RawMessage{"title": json.RawMessage(`"Fix bug"`), "status": json.RawMessage(`"signed_off"`)}
	diff := DiffState(state, want)
	if diff == nil {
		t.Fatal("legit sign-off diffed to zero ops against the validated baseline (DoS)")
	}
	addOps(t, tree, steward.Keys.SignKey, 4000, false, diff.Ops...)

	tree.Lock()
	after, err := BuildStateValidated(tree, "contrib-1", TypeContribution, validator)
	tree.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if got := jsonStringValue(after.Fields["status"]); got != "signed_off" {
		t.Fatalf("legit steward sign-off not applied: status=%q", got)
	}

	// Blocking item 3: determinism / as-of. Demote the steward AFTER the
	// sign-off; the past sign-off stays valid, a new reward by them does not.
	resolver.Replace(RoleSnapshot{
		AccountAID: bound,
		History: map[string][]RoleAt{
			"E-steward": {{Since: 500, Role: "Operations Steward"}, {Since: 4500, Role: "Member"}},
			"E-member":  {{Since: 500, Role: "Member"}},
		},
	})
	addOps(t, tree, steward.Keys.SignKey, 5000, false, setOp("status", "rewarded"))
	tree.Lock()
	final, err := BuildStateValidated(tree, "contrib-1", TypeContribution, validator)
	tree.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if got := jsonStringValue(final.Fields["status"]); got != "signed_off" {
		t.Fatalf("after demotion: past sign-off must survive and new reward must be rejected, got %q", got)
	}
	// Dedupe: the original forgery was re-rejected on each rebuild but recorded once.
	seen := 0
	for _, r := range recorder.Recent() {
		if r.ChangeID == forgedID {
			seen++
		}
	}
	if seen != 1 {
		t.Fatalf("forged change recorded %d times, want 1", seen)
	}

	// Sanity on the role-mapping used above.
	if !contributions.CanPerformAction(contributions.MapKERIRole("Operations Steward"), contributions.ActionRewardContribution) {
		t.Fatal("test premise: ops steward can reward")
	}
}

// Real-tree check of RoleHistoryFromTree + as-of resolution end to end.
func TestRoleHistoryFromRealProfileTree(t *testing.T) {
	acl, owner, _ := twoWriterACL(t)
	tree := newEncryptedTree(t, acl, owner, "CommunityProfile-E-alice", "CommunityProfile")
	addOps(t, tree, owner.Keys.SignKey, 100, true, setOp("aid", "E-alice"), setOp("role", "Member"))
	addOps(t, tree, owner.Keys.SignKey, 300, false, setOp("role", "Operations Steward"))
	addOps(t, tree, owner.Keys.SignKey, 500, false, setOp("role", "Member"))

	tree.Lock()
	aid, hist := RoleHistoryFromTree(tree)
	tree.Unlock()
	if aid != "E-alice" {
		t.Fatalf("aid %q", aid)
	}
	want := []RoleAt{{100, "Member"}, {300, "Operations Steward"}, {500, "Member"}}
	if len(hist) != 3 {
		t.Fatalf("history %+v", hist)
	}
	for i := range want {
		if hist[i] != want[i] {
			t.Errorf("history[%d] = %+v want %+v", i, hist[i], want[i])
		}
	}
}
