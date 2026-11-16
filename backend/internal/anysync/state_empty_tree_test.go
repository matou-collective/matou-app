package anysync

import (
	"encoding/json"
	"errors"
	"testing"
)

// rejectAllValidator is a ChangeValidator that excludes every change. It models
// the state in which a tree's content changes are all present locally but none
// survive validation, so the reconstructed version is 0.
type rejectAllValidator struct{}

func (rejectAllValidator) ValidateChange(_, _, _, _, _ string, _ int64, _ []ChangeOp, _ map[string]json.RawMessage, _ bool) bool {
	return false
}

// TestBuildState_EmptyTree_ReturnsErrNoChangesInTree is the #808 regression:
// a tree that carries no content changes at all (only its root) must surface
// ErrNoChangesInTree, so the read path can tell this missing-data condition
// apart from an ordinary error and drop the incomplete local copy to re-fetch.
func TestBuildState_EmptyTree_ReturnsErrNoChangesInTree(t *testing.T) {
	tree := &fakeTree{changes: nil}

	_, err := BuildState(tree, "ip_00a9aa262ea998c7", TypeImplementationPlan)
	if err == nil {
		t.Fatal("expected an error for a tree with no content changes")
	}
	if !errors.Is(err, ErrNoChangesInTree) {
		t.Fatalf("expected ErrNoChangesInTree, got %v", err)
	}
	if errors.Is(err, ErrAllChangesRejected) {
		t.Fatal("an empty tree must NOT report ErrAllChangesRejected")
	}
}

// TestBuildState_AllChangesRejected_IsDistinct guards the data-safety boundary:
// when content changes ARE present locally but a validator excludes every one of
// them, the version is still 0 but this is NOT a missing-data condition —
// re-fetching the same bytes cannot help — so it must surface ErrAllChangesRejected,
// NOT ErrNoChangesInTree. The read path keys its drop-and-refetch off
// ErrNoChangesInTree alone, so this distinction keeps it from dropping a tree
// whose changes are present but merely rejected.
func TestBuildState_AllChangesRejected_IsDistinct(t *testing.T) {
	tree := &fakeTree{changes: []fakeChange{
		{id: "c1", timestamp: 100, snapshot: true, ops: []ChangeOp{setOp("title", "Operations")}},
		{id: "c2", timestamp: 200, ops: []ChangeOp{setOp("title", "Operations v2")}},
	}}

	_, err := BuildStateValidated(tree, "space-1", "ip_00a9aa262ea998c7", TypeImplementationPlan, rejectAllValidator{})
	if err == nil {
		t.Fatal("expected an error when every change is rejected")
	}
	if !errors.Is(err, ErrAllChangesRejected) {
		t.Fatalf("expected ErrAllChangesRejected, got %v", err)
	}
	if errors.Is(err, ErrNoChangesInTree) {
		t.Fatal("a tree with present-but-rejected changes must NOT report ErrNoChangesInTree (it would trigger an unnecessary re-fetch)")
	}
}

// TestBuildState_WithChanges_NoError confirms the healthy path still builds and
// reports neither sentinel, so the #808 detection does not fire for a normal
// plan that loads fine.
func TestBuildState_WithChanges_NoError(t *testing.T) {
	tree := &fakeTree{changes: []fakeChange{
		{id: "c1", timestamp: 100, snapshot: true, ops: []ChangeOp{setOp("title", "Operations")}},
	}}

	state, err := BuildState(tree, "ip_00a9aa262ea998c7", TypeImplementationPlan)
	if err != nil {
		t.Fatalf("healthy tree must build, got %v", err)
	}
	if state.Version != 1 {
		t.Fatalf("expected version 1, got %d", state.Version)
	}
}
