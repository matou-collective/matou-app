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

// TestAC1_ForgedSignOffOnRealTree_Crypto is the GH#19 part-2 acceptance test.
// On a REAL any-sync object tree (real change builder, signature + ACL
// validation, encryption), a writer-permission peer that forges a high-stakes
// sign-off — either with no proof, or with a proof that claims a steward's AID
// but is signed with the attacker's own key — is excluded from every honest
// peer's derived state, while the steward's genuinely-signed sign-off applies.
// Proof enforcement is ON (as under MATOU_REQUIRE_SIGNED_AUTH).
func TestAC1_ForgedSignOffOnRealTree_Crypto(t *testing.T) {
	acl, steward, member := twoWriterACL(t)

	stewardSigner := newSigner(t, "E-steward")
	keys := NewStaticKeyProvider()
	keys.Set(stewardSigner.aid, stewardSigner.verfer)

	// Roles keyed by the crypto-verified AID: the steward AID is an ops steward,
	// the member AID a plain member.
	resolver := fakeResolver{
		"E-steward": contributions.MapKERIRole("Operations Steward"),
		"E-member":  contributions.MapKERIRole("Member"),
	}
	recorder := NewLoggingRejectionRecorder(10)
	validator := NewWriteRuleValidator(resolver, keys, recorder, true)

	const spaceID = "space-test"
	tree := newEncryptedTree(t, acl, steward, "contrib-1", TypeContribution)

	// Steward creates + assigns (legit, no proof needed).
	addOps(t, tree, steward.Keys.SignKey, 2000, true, setOp("title", "Fix bug"), setOp("status", "assigned"))

	// FORGERY: member writes a sign-off with a proof claiming the steward's AID
	// but signed with the member's OWN key (they lack the steward's key).
	forger := newSigner(t, "E-member")
	forged := forger.sign("contribution_signoff", "contrib-1", spaceID, "signed_off", "2026-08-27T01:00:00Z")
	forged.AID = "E-steward" // claim the steward's identity
	forgedJSON, _ := json.Marshal(forged)
	forgedID := addOps(t, tree, member.Keys.SignKey, 3000, false,
		setOp("status", "signed_off"), rawOp("sign_off_proof", string(forgedJSON)))

	build := func() *ObjectState {
		tree.Lock()
		defer tree.Unlock()
		st, err := BuildStateValidated(tree, spaceID, "contrib-1", TypeContribution, validator)
		if err != nil {
			t.Fatal(err)
		}
		return st
	}

	// AC-1: the forged sign-off is excluded from derived state.
	state := build()
	if got := jsonStringValue(state.Fields["status"]); got != "assigned" {
		t.Fatalf("forged sign-off entered state: status=%q", got)
	}
	if got := jsonStringValue(state.Fields["title"]); got != "Fix bug" {
		t.Fatalf("unrelated field lost: title=%q", got)
	}
	if rej := recorder.Recent(); len(rej) != 1 || rej[0].ChangeID != forgedID {
		t.Fatalf("forged change must be recorded once, got %+v", rej)
	}

	// The raw (unvalidated) tree DOES contain the forgery — the SDK accepted it.
	tree.Lock()
	raw, _ := BuildState(tree, "contrib-1", TypeContribution)
	tree.Unlock()
	if jsonStringValue(raw.Fields["status"]) != "signed_off" {
		t.Fatal("sanity: SDK should have accepted the forged change into the tree")
	}

	// The steward's genuinely-signed sign-off applies.
	proof := stewardSigner.sign("contribution_signoff", "contrib-1", spaceID, "signed_off", "2026-08-27T02:00:00Z")
	proofJSON, _ := json.Marshal(proof)
	addOps(t, tree, steward.Keys.SignKey, 4000, false,
		setOp("status", "signed_off"), rawOp("sign_off_proof", string(proofJSON)))

	after := build()
	if got := jsonStringValue(after.Fields["status"]); got != "signed_off" {
		t.Fatalf("legit steward sign-off not applied: status=%q", got)
	}

	// A member sign-off with NO proof at all is also rejected (fail-closed).
	tree2 := newEncryptedTree(t, acl, steward, "contrib-2", TypeContribution)
	addOps(t, tree2, steward.Keys.SignKey, 2000, true, setOp("status", "assigned"))
	addOps(t, tree2, member.Keys.SignKey, 3000, false, setOp("status", "signed_off"))
	tree2.Lock()
	st2, err := BuildStateValidated(tree2, spaceID, "contrib-2", TypeContribution, validator)
	tree2.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if got := jsonStringValue(st2.Fields["status"]); got != "assigned" {
		t.Fatalf("proofless sign-off must be rejected, status=%q", got)
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
