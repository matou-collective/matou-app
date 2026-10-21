package contributions

import (
	"context"
	"testing"
)

// TestDerivePlanReferences_TopLevelAndSubs exercises the pure derivation over a
// hand-built plan: two milestones, top-level contributions numbered M.C.0, and
// one parent's children numbered M.C.S.
func TestDerivePlanReferences_TopLevelAndSubs(t *testing.T) {
	a := &Contribution{ID: "a", Title: "Alpha", ChildContributionIDs: []string{"a1", "a2"}}
	b := &Contribution{ID: "b", Title: "Bravo"}
	x := &Contribution{ID: "x", Title: "Xray"}
	a1 := &Contribution{ID: "a1", Title: "Child A", ParentContributionID: "a"}
	a2 := &Contribution{ID: "a2", Title: "Child B", ParentContributionID: "a"}
	byID := map[string]*Contribution{"a": a, "b": b, "x": x, "a1": a1, "a2": a2}

	plan := &ImplementationPlan{
		Milestones: []Milestone{
			{MilestoneID: "m1", ContributionIDs: []string{"a", "b"}},
			{MilestoneID: "m2", ContributionIDs: []string{"x"}},
		},
	}

	out := map[string]string{}
	derivePlanReferences(plan, byID, out)

	want := map[string]string{
		"a":  "1.1.0",
		"b":  "1.2.0",
		"a1": "1.1.1",
		"a2": "1.1.2",
		"x":  "2.1.0",
	}
	for id, w := range want {
		if out[id] != w {
			t.Errorf("reference[%s] = %q, want %q", id, out[id], w)
		}
	}
}

// TestDerivePlanReferences_ExplicitOrder confirms references follow sort_order,
// not title, when siblings carry explicit positions.
func TestDerivePlanReferences_ExplicitOrder(t *testing.T) {
	a := &Contribution{ID: "a", Title: "Alpha", SortOrder: intPtr(2)}
	b := &Contribution{ID: "b", Title: "Bravo", SortOrder: intPtr(0)}
	c := &Contribution{ID: "c", Title: "Charlie", SortOrder: intPtr(1)}
	byID := map[string]*Contribution{"a": a, "b": b, "c": c}
	plan := &ImplementationPlan{Milestones: []Milestone{{MilestoneID: "m1", ContributionIDs: []string{"a", "b", "c"}}}}

	out := map[string]string{}
	derivePlanReferences(plan, byID, out)

	// sort_order b(0), c(1), a(2) → 1.1.0, 1.2.0, 1.3.0
	if out["b"] != "1.1.0" || out["c"] != "1.2.0" || out["a"] != "1.3.0" {
		t.Errorf("explicit-order references wrong: b=%q c=%q a=%q", out["b"], out["c"], out["a"])
	}
}

// TestDerivePlanReferences_ArchivedNumberedLast verifies the gap behavior: an
// archived sibling is numbered after the active ones, so the active references
// stay contiguous (no confusing gap) while the archived one keeps a reference.
func TestDerivePlanReferences_ArchivedNumberedLast(t *testing.T) {
	a := &Contribution{ID: "a", Title: "Alpha", SortOrder: intPtr(0)}
	b := &Contribution{ID: "b", Title: "Bravo", SortOrder: intPtr(1), Status: ContribArchived}
	c := &Contribution{ID: "c", Title: "Charlie", SortOrder: intPtr(2)}
	byID := map[string]*Contribution{"a": a, "b": b, "c": c}
	plan := &ImplementationPlan{Milestones: []Milestone{{MilestoneID: "m1", ContributionIDs: []string{"a", "b", "c"}}}}

	out := map[string]string{}
	derivePlanReferences(plan, byID, out)

	if out["a"] != "1.1.0" || out["c"] != "1.2.0" {
		t.Errorf("active references not contiguous: a=%q c=%q (want 1.1.0, 1.2.0)", out["a"], out["c"])
	}
	if out["b"] != "1.3.0" {
		t.Errorf("archived reference = %q, want 1.3.0 (numbered after active)", out["b"])
	}
}

// TestDerivePlanReferences_SubWithMilestoneIDNotDoubleCounted guards the case
// where a sub-contribution also carries a milestone_id (so it appears in the
// milestone's ContributionIDs): it must be numbered as a sub, not as a
// top-level, and must not displace the real top-level numbering.
func TestDerivePlanReferences_SubWithMilestoneIDNotDoubleCounted(t *testing.T) {
	parent := &Contribution{ID: "p", Title: "Parent", ChildContributionIDs: []string{"s"}}
	sub := &Contribution{ID: "s", Title: "Sub", ParentContributionID: "p"}
	byID := map[string]*Contribution{"p": parent, "s": sub}
	// The milestone lists both the parent and the sub (sub carried a milestone_id).
	plan := &ImplementationPlan{Milestones: []Milestone{{MilestoneID: "m1", ContributionIDs: []string{"p", "s"}}}}

	out := map[string]string{}
	derivePlanReferences(plan, byID, out)

	if out["p"] != "1.1.0" {
		t.Errorf("parent reference = %q, want 1.1.0", out["p"])
	}
	if out["s"] != "1.1.1" {
		t.Errorf("sub reference = %q, want 1.1.1 (numbered under its parent)", out["s"])
	}
}

// TestReferencesForProject_RenumbersOnReorder is the end-to-end path through the
// service: create contributions, assert their references, reorder, and assert
// the references renumber to match the new positions with no manual step.
func TestReferencesForProject_RenumbersOnReorder(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, msID := setupReorderPlan(ctx, t, svc, spaceID)

	a := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "A"})
	b := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "B"})
	c := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "C"})

	refs, err := svc.ReferencesForProject(ctx, spaceID, projID)
	if err != nil {
		t.Fatalf("ReferencesForProject: %v", err)
	}
	if refs[a.ID] != "1.1.0" || refs[b.ID] != "1.2.0" || refs[c.ID] != "1.3.0" {
		t.Fatalf("initial references wrong: A=%q B=%q C=%q", refs[a.ID], refs[b.ID], refs[c.ID])
	}

	// Reorder to C, A, B.
	if _, err := svc.ReorderContributions(ctx, spaceID, a.ID, []string{c.ID, a.ID, b.ID}, "u"); err != nil {
		t.Fatalf("ReorderContributions: %v", err)
	}
	refs, err = svc.ReferencesForProject(ctx, spaceID, projID)
	if err != nil {
		t.Fatalf("ReferencesForProject after reorder: %v", err)
	}
	if refs[c.ID] != "1.1.0" || refs[a.ID] != "1.2.0" || refs[b.ID] != "1.3.0" {
		t.Fatalf("post-reorder references wrong: C=%q A=%q B=%q", refs[c.ID], refs[a.ID], refs[b.ID])
	}
}

// TestReferencesForProject_Subs covers a parent's children numbered under it.
func TestReferencesForProject_Subs(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, msID := setupReorderPlan(ctx, t, svc, spaceID)

	parent := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "Parent"})
	c1 := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, ParentContributionID: parent.ID, Title: "Child1"})
	c2 := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, ParentContributionID: parent.ID, Title: "Child2"})

	refs, err := svc.ReferencesForProject(ctx, spaceID, projID)
	if err != nil {
		t.Fatalf("ReferencesForProject: %v", err)
	}
	if refs[parent.ID] != "1.1.0" || refs[c1.ID] != "1.1.1" || refs[c2.ID] != "1.1.2" {
		t.Fatalf("sub references wrong: parent=%q c1=%q c2=%q", refs[parent.ID], refs[c1.ID], refs[c2.ID])
	}
}

// TestStampReferences sets Reference on the exact objects passed, grouped by
// project, matching what the read handlers serialize.
func TestStampReferences(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, msID := setupReorderPlan(ctx, t, svc, spaceID)

	a := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "A"})
	b := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "B"})

	list := []*Contribution{a, b}
	svc.StampReferences(ctx, spaceID, list)
	if a.Reference != "1.1.0" || b.Reference != "1.2.0" {
		t.Fatalf("stamped references wrong: A=%q B=%q", a.Reference, b.Reference)
	}
}
