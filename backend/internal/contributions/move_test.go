package contributions

import (
	"context"
	"testing"
)

// setupTwoMilestonePlan builds a project + plan with two milestones and returns
// their ids. Both milestones belong to the same implementation plan.
func setupTwoMilestonePlan(ctx context.Context, t *testing.T, svc *Service, spaceID string) (projectID, planID, ms1, ms2 string) {
	t.Helper()
	proj, err := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	plan, err := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	if err != nil {
		t.Fatalf("CreateImplementationPlan: %v", err)
	}
	m1, err := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{ImplementationPlanID: plan.ID, Title: "M1", Duration: "1w"})
	if err != nil {
		t.Fatalf("AddMilestone M1: %v", err)
	}
	m2, err := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{ImplementationPlanID: plan.ID, Title: "M2", Duration: "1w"})
	if err != nil {
		t.Fatalf("AddMilestone M2: %v", err)
	}
	return proj.ID, plan.ID, m1.MilestoneID, m2.MilestoneID
}

func contains(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func TestMoveContributionToMilestone_SyncsAllStores(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, planID, ms1, ms2 := setupTwoMilestonePlan(ctx, t, svc, spaceID)

	c := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: ms1, Title: "A"})

	// Sign the plan off so we can assert the move invalidates it.
	plan, err := svc.GetImplementationPlan(ctx, spaceID, planID)
	if err != nil {
		t.Fatalf("GetImplementationPlan: %v", err)
	}
	plan.SignedOff = true
	if err := svc.SaveImplementationPlan(ctx, spaceID, plan); err != nil {
		t.Fatalf("SaveImplementationPlan: %v", err)
	}

	moved, err := svc.MoveContributionToMilestone(ctx, spaceID, c.ID, ms2, "mover")
	if err != nil {
		t.Fatalf("MoveContributionToMilestone: %v", err)
	}
	if moved.MilestoneID != ms2 {
		t.Errorf("moved.MilestoneID = %q, want %q", moved.MilestoneID, ms2)
	}

	// 1. Contribution record points at the new milestone.
	fresh, err := svc.GetContribution(ctx, spaceID, c.ID)
	if err != nil {
		t.Fatalf("GetContribution: %v", err)
	}
	if fresh.MilestoneID != ms2 {
		t.Errorf("fresh contribution milestone = %q, want %q", fresh.MilestoneID, ms2)
	}
	if fresh.SortOrder == nil {
		t.Error("moved contribution has no sort order")
	}

	// 2. Standalone milestone membership lists are consistent.
	src, err := svc.GetMilestone(ctx, spaceID, ms1)
	if err != nil {
		t.Fatalf("GetMilestone src: %v", err)
	}
	if contains(src.ContributionIDs, c.ID) {
		t.Errorf("source milestone still lists %s: %v", c.ID, src.ContributionIDs)
	}
	dst, err := svc.GetMilestone(ctx, spaceID, ms2)
	if err != nil {
		t.Fatalf("GetMilestone dst: %v", err)
	}
	if !contains(dst.ContributionIDs, c.ID) {
		t.Errorf("target milestone does not list %s: %v", c.ID, dst.ContributionIDs)
	}

	// 3. Inline plan milestone copies reflect the move.
	plan, err = svc.GetImplementationPlan(ctx, spaceID, planID)
	if err != nil {
		t.Fatalf("GetImplementationPlan after move: %v", err)
	}
	for i := range plan.Milestones {
		m := &plan.Milestones[i]
		switch m.MilestoneID {
		case ms1:
			if contains(m.ContributionIDs, c.ID) {
				t.Errorf("inline source milestone still lists %s: %v", c.ID, m.ContributionIDs)
			}
		case ms2:
			if !contains(m.ContributionIDs, c.ID) {
				t.Errorf("inline target milestone does not list %s: %v", c.ID, m.ContributionIDs)
			}
		}
	}

	// 4. Sign-off invalidated and a contribution_moved entry recorded.
	if plan.SignedOff {
		t.Error("plan still signed off after move")
	}
	if len(plan.ChangeLog) == 0 {
		t.Fatal("no change-log entry recorded for move")
	}
	last := plan.ChangeLog[len(plan.ChangeLog)-1]
	if last.Kind != "contribution_moved" {
		t.Errorf("last change-log kind = %q, want contribution_moved", last.Kind)
	}
	if last.ContributionID != c.ID {
		t.Errorf("change-log contribution id = %q, want %q", last.ContributionID, c.ID)
	}
}

func TestMoveContributionToMilestone_RejectsSubContribution(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, _, ms1, ms2 := setupTwoMilestonePlan(ctx, t, svc, spaceID)

	parent := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: ms1, Title: "Parent"})
	sub := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, ParentContributionID: parent.ID, Title: "Sub"})

	if _, err := svc.MoveContributionToMilestone(ctx, spaceID, sub.ID, ms2, "mover"); err == nil {
		t.Error("expected error moving a sub-contribution, got nil")
	}
}

func TestMoveContributionToMilestone_SourceStaysContiguous(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, _, ms1, ms2 := setupTwoMilestonePlan(ctx, t, svc, spaceID)

	a := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: ms1, Title: "A"})
	b := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: ms1, Title: "B"})
	cc := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: ms1, Title: "C"})

	// Move the middle one to the other milestone.
	if _, err := svc.MoveContributionToMilestone(ctx, spaceID, b.ID, ms2, "mover"); err != nil {
		t.Fatalf("MoveContributionToMilestone: %v", err)
	}

	// Remaining source siblings A, C renumber to a contiguous 0, 1.
	wantOrder := map[string]int{a.ID: 0, cc.ID: 1}
	for id, want := range wantOrder {
		got, err := svc.GetContribution(ctx, spaceID, id)
		if err != nil {
			t.Fatalf("GetContribution %s: %v", id, err)
		}
		if got.SortOrder == nil || *got.SortOrder != want {
			t.Errorf("contribution %s sort order = %v, want %d", id, got.SortOrder, want)
		}
	}
}

func TestMoveContributionToMilestone_SameMilestoneNoop(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	projID, planID, ms1, _ := setupTwoMilestonePlan(ctx, t, svc, spaceID)

	c := createContrib(ctx, t, svc, spaceID, &CreateContributionRequest{ProjectID: projID, MilestoneID: ms1, Title: "A"})

	if _, err := svc.MoveContributionToMilestone(ctx, spaceID, c.ID, ms1, "mover"); err != nil {
		t.Fatalf("no-op move returned error: %v", err)
	}

	// No change-log entry should be recorded for a no-op move.
	plan, err := svc.GetImplementationPlan(ctx, spaceID, planID)
	if err != nil {
		t.Fatalf("GetImplementationPlan: %v", err)
	}
	for _, e := range plan.ChangeLog {
		if e.Kind == "contribution_moved" {
			t.Error("no-op move recorded a contribution_moved entry")
		}
	}
}
