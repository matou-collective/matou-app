package contributions

import (
	"context"
	"testing"
)

func intPtr(n int) *int { return &n }

func TestActionReorderContribution_LeadStewardOnly(t *testing.T) {
	cases := []struct {
		role    Role
		allowed bool
	}{
		{RoleProjectLead, true},
		{RoleProjectSteward, true},
		{RoleFoundingMember, true},
		{RoleOperationsSteward, true},
		{RoleMember, false},
		{RoleContributor, false},
	}
	for _, c := range cases {
		if got := CanPerformAction([]Role{c.role}, ActionReorderContribution); got != c.allowed {
			t.Errorf("ActionReorderContribution for %s: got %v, want %v", c.role, got, c.allowed)
		}
	}
}

func TestNaturalLess_NumericAware(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"1.2.9", "1.2.10", true},  // 9 < 10 numerically
		{"1.2.10", "1.2.9", false}, // reverse
		{"item2", "item10", true},  // 2 < 10
		{"item10", "item2", false}, //
		{"a", "b", true},           // plain lexical
		{"Audit", "target", true},  // case-insensitive A < t
		{"1.10", "1.2", false},     // 10 > 2
		{"v1", "v1", false},        // equal
		{"section 1", "section 2", true},
	}
	for _, c := range cases {
		if got := naturalLess(c.a, c.b); got != c.want {
			t.Errorf("naturalLess(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestSortSiblings_FallbackNaturalTitle(t *testing.T) {
	// No contribution carries an explicit order → numeric-aware title sort,
	// so 1.2.10 comes after 1.2.9.
	cs := []*Contribution{
		{ID: "c", Title: "1.2.10"},
		{ID: "a", Title: "1.2.2"},
		{ID: "b", Title: "1.2.9"},
	}
	SortSiblings(cs)
	got := []string{cs[0].Title, cs[1].Title, cs[2].Title}
	want := []string{"1.2.2", "1.2.9", "1.2.10"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("fallback order = %v, want %v", got, want)
		}
	}
}

func TestSortSiblings_ExplicitOrderWins(t *testing.T) {
	cs := []*Contribution{
		{ID: "a", Title: "Alpha", SortOrder: intPtr(2)},
		{ID: "b", Title: "Bravo", SortOrder: intPtr(0)},
		{ID: "c", Title: "Charlie", SortOrder: intPtr(1)},
	}
	SortSiblings(cs)
	got := []string{cs[0].ID, cs[1].ID, cs[2].ID}
	want := []string{"b", "c", "a"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("explicit order = %v, want %v", got, want)
		}
	}
}

func TestSortSiblings_OrderedAfterUnordered(t *testing.T) {
	// An unordered legacy item sorts ahead of an explicitly-ordered new item,
	// so a newly created contribution lands at the end of a legacy list.
	cs := []*Contribution{
		{ID: "new", Title: "0-would-be-first-by-title", SortOrder: intPtr(0)},
		{ID: "old1", Title: "Apple"},
		{ID: "old2", Title: "Banana"},
	}
	SortSiblings(cs)
	got := []string{cs[0].ID, cs[1].ID, cs[2].ID}
	want := []string{"old1", "old2", "new"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("mixed order = %v, want %v", got, want)
		}
	}
}

// setupReorderPlan builds a project + plan + milestone and returns ids.
func setupReorderPlan(ctx context.Context, t *testing.T, svc *Service, spaceID string) (projectID, milestoneID string) {
	t.Helper()
	proj, err := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	plan, err := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	if err != nil {
		t.Fatalf("CreateImplementationPlan: %v", err)
	}
	ms, err := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: plan.ID, Title: "M", Duration: "1w",
	})
	if err != nil {
		t.Fatalf("AddMilestone: %v", err)
	}
	return proj.ID, ms.MilestoneID
}

func createContrib(ctx context.Context, t *testing.T, svc *Service, spaceID string, req *CreateContributionRequest) *Contribution {
	t.Helper()
	req.Description = "d"
	req.ContributionType = ProposalTypeTechnical
	req.Priority = PriorityMedium
	req.CreatedBy = "u"
	req.Objectives = []string{"o"}
	req.Deliverables = []string{"d"}
	req.AcceptanceCriteria = []string{"a"}
	req.SkillRequirements = []string{"s"}
	c, err := svc.CreateContribution(ctx, spaceID, req)
	if err != nil {
		t.Fatalf("CreateContribution %q: %v", req.Title, err)
	}
	return c
}

func TestCreateContribution_DefaultsToEndOfSiblings(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, msID := setupReorderPlan(ctx, t, svc, spaceID)

	a := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "A"})
	b := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "B"})
	c := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "C"})

	for i, got := range []*Contribution{a, b, c} {
		if got.SortOrder == nil {
			t.Fatalf("%s has nil SortOrder", got.Title)
		}
		if *got.SortOrder != i {
			t.Errorf("%s SortOrder = %d, want %d", got.Title, *got.SortOrder, i)
		}
	}
}

func TestCreateContribution_ExplicitOrder(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, msID := setupReorderPlan(ctx, t, svc, spaceID)

	c := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "A", Order: intPtr(42)})
	if c.SortOrder == nil || *c.SortOrder != 42 {
		t.Fatalf("explicit order not honored: %v", c.SortOrder)
	}
}

func TestReorderContributions_RoundTrip(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, msID := setupReorderPlan(ctx, t, svc, spaceID)

	a := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "A"})
	b := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "B"})
	c := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "C"})

	// Reorder to C, A, B using B as the representative.
	if _, err := svc.ReorderContributions(ctx, spaceID, b.ID, []string{c.ID, a.ID, b.ID}, "u"); err != nil {
		t.Fatalf("ReorderContributions: %v", err)
	}

	plan, _, err := svc.findMilestone(ctx, spaceID, msID)
	if err != nil {
		t.Fatalf("findMilestone: %v", err)
	}
	svc.HydratePlan(ctx, spaceID, plan)
	var got []string
	for i := range plan.Milestones {
		if plan.Milestones[i].MilestoneID == msID {
			for _, ct := range plan.Milestones[i].Contributions {
				got = append(got, ct.Title)
			}
		}
	}
	want := []string{"C", "A", "B"}
	for i := range want {
		if i >= len(got) || got[i] != want[i] {
			t.Fatalf("hydrated order = %v, want %v", got, want)
		}
	}

	// A reorder is recorded on the plan change log.
	entries := plan.ChangeLog
	last := entries[len(entries)-1]
	if last.Kind != "contribution_reordered" {
		t.Errorf("last change log kind = %q, want contribution_reordered", last.Kind)
	}
}

func TestReorderContributions_RejectsNonPermutation(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, msID := setupReorderPlan(ctx, t, svc, spaceID)

	a := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "A"})
	b := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "B"})

	// Dropping a sibling is rejected.
	if _, err := svc.ReorderContributions(ctx, spaceID, a.ID, []string{a.ID}, "u"); err == nil {
		t.Error("expected error for incomplete reorder list")
	}

	// A foreign id (different milestone) is rejected.
	_, msID2 := setupReorderPlan(ctx, t, svc, spaceID)
	foreign := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID2, Title: "Foreign"})
	if _, err := svc.ReorderContributions(ctx, spaceID, a.ID, []string{a.ID, b.ID, foreign.ID}, "u"); err == nil {
		t.Error("expected error for cross-milestone reorder id")
	}
}

func TestReorderContributions_Children(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, msID := setupReorderPlan(ctx, t, svc, spaceID)

	parent := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: msID, Title: "Parent"})
	c1 := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, ParentContributionID: parent.ID, Title: "Child1"})
	c2 := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, ParentContributionID: parent.ID, Title: "Child2"})

	if c1.SortOrder == nil || *c1.SortOrder != 0 || c2.SortOrder == nil || *c2.SortOrder != 1 {
		t.Fatalf("children default order wrong: c1=%v c2=%v", c1.SortOrder, c2.SortOrder)
	}

	if _, err := svc.ReorderContributions(ctx, spaceID, c1.ID, []string{c2.ID, c1.ID}, "u"); err != nil {
		t.Fatalf("reorder children: %v", err)
	}
	got1, _ := svc.GetContribution(ctx, spaceID, c1.ID)
	got2, _ := svc.GetContribution(ctx, spaceID, c2.ID)
	if *got2.SortOrder != 0 || *got1.SortOrder != 1 {
		t.Fatalf("child reorder wrong: c2=%d c1=%d", *got2.SortOrder, *got1.SortOrder)
	}
}
