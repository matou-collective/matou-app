package anysync

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
)

// stubTree is a minimal objecttree.ObjectTree whose only meaningful method is
// Id(). FreshTreeForReading never inspects anything else, so the embedded nil
// interface is never dereferenced.
type stubTree struct {
	objecttree.ObjectTree
	id string
}

func (s *stubTree) Id() string { return s.id } //nolint:revive // method name fixed by objecttree.ObjectTree interface

// TestFreshTreeCandidateSpaces_UnionAndDedup asserts the fallback's candidate
// set is the union of indexed spaces (KnownSpaceIDs) and the resolver's open
// spaces (OpenSpaceIDs), with duplicates collapsed. This is the item-5 fix: an
// open-but-unindexed space must appear in the set the fallback probes.
func TestFreshTreeCandidateSpaces_UnionAndDedup(t *testing.T) {
	utm := NewUnifiedTreeManager()
	// "space-indexed" has an indexed tree; "space-open" is open but has none.
	utm.addToIndex("space-indexed", "tree-1", ObjectIndexEntry{TreeID: "tree-1", ObjectID: "obj-1", ChangeType: ProfileTreeType})
	utm.openSpacesFn = func() []string { return []string{"space-open", "space-indexed"} }

	got := utm.freshTreeCandidateSpaces()
	sort.Strings(got)
	want := []string{"space-indexed", "space-open"}
	if len(got) != len(want) {
		t.Fatalf("candidate spaces = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("candidate spaces = %v, want %v", got, want)
		}
	}
}

// TestFreshTreeForReading_FastPath asserts that when the tree is already indexed
// the fallback builds it straight from its space without re-indexing.
func TestFreshTreeForReading_FastPath(t *testing.T) {
	utm := NewUnifiedTreeManager()
	utm.addToIndex("space-1", "tree-fast", ObjectIndexEntry{TreeID: "tree-fast", ObjectID: "obj-fast", ChangeType: ProfileTreeType})

	indexCalls := 0
	utm.buildIndexFn = func(_ context.Context, _ string) error { indexCalls++; return nil }
	utm.buildFreshFn = func(_ context.Context, spaceID, treeID string) (objecttree.ObjectTree, error) {
		if spaceID != "space-1" || treeID != "tree-fast" {
			return nil, errors.New("wrong space/tree")
		}
		return &stubTree{id: treeID}, nil
	}

	tree, err := utm.FreshTreeForReading(context.Background(), "tree-fast")
	if err != nil {
		t.Fatalf("FreshTreeForReading fast path: %v", err)
	}
	if tree.Id() != "tree-fast" {
		t.Fatalf("got tree %q, want tree-fast", tree.Id())
	}
	if indexCalls != 0 {
		t.Fatalf("fast path re-indexed %d times, want 0", indexCalls)
	}
}

// TestFreshTreeForReading_OpenButUnindexedSpace is the item-5 regression: a
// space that is open (in the resolver cache) but has zero indexed trees must be
// probed by the fallback. The old KnownSpaceIDs-only probe skipped it, so a tree
// in a freshly-joined/empty space could not be located until a later listener
// fire. Here KnownSpaceIDs is empty and the tree lives in the open space.
func TestFreshTreeForReading_OpenButUnindexedSpace(t *testing.T) {
	utm := NewUnifiedTreeManager()
	// No indexed trees at all → KnownSpaceIDs() is empty.
	utm.openSpacesFn = func() []string { return []string{"space-open"} }

	var mu sync.Mutex
	indexed := map[string]bool{}
	utm.buildIndexFn = func(_ context.Context, spaceID string) error {
		mu.Lock()
		indexed[spaceID] = true
		mu.Unlock()
		return nil // indexing the empty space adds nothing to the index
	}
	utm.buildFreshFn = func(_ context.Context, spaceID, treeID string) (objecttree.ObjectTree, error) {
		if spaceID == "space-open" && treeID == "tree-orphan" {
			return &stubTree{id: treeID}, nil
		}
		return nil, errors.New("not in this space")
	}

	tree, err := utm.FreshTreeForReading(context.Background(), "tree-orphan")
	if err != nil {
		t.Fatalf("FreshTreeForReading should locate a tree in an open-but-unindexed space: %v", err)
	}
	if tree.Id() != "tree-orphan" {
		t.Fatalf("got tree %q, want tree-orphan", tree.Id())
	}
	mu.Lock()
	probed := indexed["space-open"]
	mu.Unlock()
	if !probed {
		t.Fatal("slow path did not re-index the open space")
	}
}

// TestFreshTreeForReading_NotFound asserts a clear error when the tree is in no
// candidate space.
func TestFreshTreeForReading_NotFound(t *testing.T) {
	utm := NewUnifiedTreeManager()
	utm.openSpacesFn = func() []string { return []string{"space-a", "space-b"} }
	utm.buildIndexFn = func(_ context.Context, _ string) error { return nil }
	utm.buildFreshFn = func(_ context.Context, _, _ string) (objecttree.ObjectTree, error) {
		return nil, errors.New("no such tree")
	}

	if _, err := utm.FreshTreeForReading(context.Background(), "ghost"); err == nil {
		t.Fatal("expected error when tree is in no candidate space")
	}
}
