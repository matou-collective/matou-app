package anysync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	anystore "github.com/anyproto/any-store"
	"github.com/anyproto/any-sync/commonspace/headsync/headstorage"
	"github.com/anyproto/any-sync/commonspace/object/acl/list"
	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/commonspace/object/tree/treechangeproto"
)

// newTreeRoot builds a real object-tree root change for objectID, rooted by
// owner, exactly as the SDK does before a first persist.
func newTreeRoot(t *testing.T, acl list.AclList, owner *list.TestAclState, objectID string) *treechangeproto.RawTreeChangeWithId {
	t.Helper()
	header, _ := json.Marshal(TreeRootHeader{ObjectID: objectID, ObjectType: "ChatChannel"})
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
	return root
}

// TestIsFirstPersistCorruption asserts the classifier fires on the #129
// first-persist-failure signature and stays silent for healthy / unrelated
// errors so a live tree is never dropped.
func TestIsFirstPersistCorruption(t *testing.T) {
	commonSnapshotErr := fmt.Errorf("failed to get head entry for common snapshot: %w", anystore.ErrDocNotFound)

	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"common snapshot doc not found", commonSnapshotErr, true},
		{"wrapped common snapshot", fmt.Errorf("syncing tree: %w", commonSnapshotErr), true},
		{"building tree wrap (GetTree)", fmt.Errorf("building tree %s: %w", "abc", commonSnapshotErr), true},
		// A bare savepoint tx error is a distinct, possibly-transient failure and
		// is NOT the surfaced signal — it must not drop a tree's rows.
		{"no such savepoint (not the surfaced signal)", errors.New("any-store: sqlite: no such savepoint: sp42"), false},
		{"unknown tree id (ordinary miss)", errors.New("unknown tree id"), false},
		{"plain doc not found without context", anystore.ErrDocNotFound, false},
		{"unrelated error", errors.New("connection reset by peer"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isFirstPersistCorruption(tc.err); got != tc.want {
				t.Fatalf("isFirstPersistCorruption(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestDropTreeRows_ReproducesAndRecovers is the #129 slice-2 proof. It:
//  1. persists a healthy tree and confirms it reads back,
//  2. reproduces the exact rebuild-loop error by deleting the head entry while
//     leaving the change rows intact (CommonSnapshot → "document not found"),
//  3. shows the loop is unbreakable in that state — the SDK can neither read
//     the tree (head gone) nor re-persist it (orphan change rows block the
//     insert), and
//  4. drops the orphan rows via dropTreeRows and confirms a re-fetched copy
//     (modelled by re-persisting, i.e. a peer serving the tree) persists and
//     reads cleanly — the loop is broken.
func TestDropTreeRows_ReproducesAndRecovers(t *testing.T) {
	ctx := context.Background()
	acl, owner, _ := twoWriterACL(t)

	db, err := anystore.Open(ctx, filepath.Join(t.TempDir(), "changes.db"), nil)
	if err != nil {
		t.Fatalf("anystore: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	hs, err := headstorage.New(ctx, db)
	if err != nil {
		t.Fatalf("headstorage: %v", err)
	}

	root := newTreeRoot(t, acl, owner, "ChatChannel-recover")
	treeID := root.Id
	if _, err := objecttree.CreateStorage(ctx, root, hs, db); err != nil {
		t.Fatalf("CreateStorage: %v", err)
	}

	// (1) Healthy: the tree opens and its common snapshot resolves.
	st, err := objecttree.NewStorage(ctx, treeID, hs, db)
	if err != nil {
		t.Fatalf("NewStorage on healthy tree: %v", err)
	}
	if cs, err := st.CommonSnapshot(ctx); err != nil || cs != treeID {
		t.Fatalf("healthy CommonSnapshot = %q err=%v, want %q", cs, err, treeID)
	}

	// (2) Corrupt: delete the head entry, leave the change rows. This is what a
	// failed first-persist transaction leaves behind (head written in the same
	// tx that rolled back). CommonSnapshot on the live storage now reproduces
	// the loop error exactly.
	if err := hs.DeleteEntry(ctx, treeID); err != nil {
		t.Fatalf("delete head entry: %v", err)
	}
	if _, err := st.CommonSnapshot(ctx); err == nil {
		t.Fatal("expected CommonSnapshot to fail after head entry deletion")
	} else if !isFirstPersistCorruption(err) {
		t.Fatalf("corruption error not classified: %v", err)
	}
	if has, _ := st.Has(ctx, treeID); !has {
		t.Fatal("expected orphan change rows to remain after head deletion")
	}

	// (3) The loop is unbreakable in this state: re-persisting the tree (as a
	// peer re-serving it would) fails because the orphan change rows block the
	// root insert.
	if _, err := objecttree.CreateStorage(ctx, root, hs, db); err == nil {
		t.Fatal("expected re-persist to fail while orphan rows remain")
	}

	// (4) Recover: drop the orphan rows + (already-missing) head entry.
	if err := dropTreeRows(ctx, db, hs, treeID); err != nil {
		t.Fatalf("dropTreeRows: %v", err)
	}
	if has, _ := st.Has(ctx, treeID); has {
		t.Fatal("expected change rows to be gone after dropTreeRows")
	}
	if _, err := hs.GetEntry(ctx, treeID); !errors.Is(err, anystore.ErrDocNotFound) {
		t.Fatalf("expected head entry gone, got err=%v", err)
	}

	// A re-fetched copy (peer serving the tree) now persists and reads cleanly.
	if _, err := objecttree.CreateStorage(ctx, root, hs, db); err != nil {
		t.Fatalf("re-persist after recovery: %v", err)
	}
	st2, err := objecttree.NewStorage(ctx, treeID, hs, db)
	if err != nil {
		t.Fatalf("NewStorage after recovery: %v", err)
	}
	if cs, err := st2.CommonSnapshot(ctx); err != nil || cs != treeID {
		t.Fatalf("post-recovery CommonSnapshot = %q err=%v, want %q", cs, err, treeID)
	}
}

// TestDropTreeRows_BlastRadius asserts dropping one tree leaves every other
// tree in the same store intact.
func TestDropTreeRows_BlastRadius(t *testing.T) {
	ctx := context.Background()
	acl, owner, _ := twoWriterACL(t)

	db, err := anystore.Open(ctx, filepath.Join(t.TempDir(), "changes.db"), nil)
	if err != nil {
		t.Fatalf("anystore: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	hs, err := headstorage.New(ctx, db)
	if err != nil {
		t.Fatalf("headstorage: %v", err)
	}

	victim := newTreeRoot(t, acl, owner, "ChatChannel-victim")
	bystander := newTreeRoot(t, acl, owner, "ChatChannel-bystander")
	if _, err := objecttree.CreateStorage(ctx, victim, hs, db); err != nil {
		t.Fatalf("persist victim: %v", err)
	}
	if _, err := objecttree.CreateStorage(ctx, bystander, hs, db); err != nil {
		t.Fatalf("persist bystander: %v", err)
	}

	if err := dropTreeRows(ctx, db, hs, victim.Id); err != nil {
		t.Fatalf("dropTreeRows: %v", err)
	}

	// Victim gone.
	if _, err := hs.GetEntry(ctx, victim.Id); !errors.Is(err, anystore.ErrDocNotFound) {
		t.Fatalf("victim head entry should be gone, got %v", err)
	}
	// Bystander intact and readable.
	st, err := objecttree.NewStorage(ctx, bystander.Id, hs, db)
	if err != nil {
		t.Fatalf("bystander NewStorage: %v", err)
	}
	if cs, err := st.CommonSnapshot(ctx); err != nil || cs != bystander.Id {
		t.Fatalf("bystander CommonSnapshot = %q err=%v, want %q", cs, err, bystander.Id)
	}
}

// TestShouldAttemptRecovery_Bounds asserts recovery is bounded to once per tree
// per window (a tree a peer cannot serve must not thrash the workers), while a
// different tree is free to recover.
func TestShouldAttemptRecovery_Bounds(t *testing.T) {
	u := NewUnifiedTreeManager()
	if !u.shouldAttemptRecovery("tree-A") {
		t.Fatal("first attempt for tree-A should be allowed")
	}
	if u.shouldAttemptRecovery("tree-A") {
		t.Fatal("second immediate attempt for tree-A should be bounded out")
	}
	if !u.shouldAttemptRecovery("tree-B") {
		t.Fatal("first attempt for a different tree should be allowed")
	}
}
