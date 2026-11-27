package contributions

import (
	"context"
	"testing"
)

func restoreFixture(t *testing.T) (*Service, string, *Project) {
	t.Helper()
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	proj, err := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	return svc, spaceID, proj
}

func restoreMk(t *testing.T, svc *Service, spaceID, projID, title, parentID string) *Contribution {
	t.Helper()
	c, err := svc.CreateContribution(context.Background(), spaceID, &CreateContributionRequest{
		ProjectID: projID, Title: title, Description: "d", ContributionType: "development", CreatedBy: "u",
		ParentContributionID: parentID,
		Objectives:           []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	if err != nil {
		t.Fatalf("CreateContribution %s: %v", title, err)
	}
	return c
}

func setStatus(t *testing.T, svc *Service, spaceID, id string, st ContributionStatus, assignee string) {
	t.Helper()
	ctx := context.Background()
	c, _ := svc.GetContribution(ctx, spaceID, id)
	c.Status = st
	c.AssignedContributorID = assignee
	if err := svc.SaveContribution(ctx, spaceID, c); err != nil {
		t.Fatal(err)
	}
}

func mustStatus(t *testing.T, svc *Service, spaceID, id string, want ContributionStatus) {
	t.Helper()
	c, err := svc.GetContribution(context.Background(), spaceID, id)
	if err != nil {
		t.Fatal(err)
	}
	if c.Status != want {
		t.Errorf("%s status = %s, want %s", c.Title, c.Status, want)
	}
}

func TestRestoreContribution_Single_ReturnsToPreviousStatus(t *testing.T) {
	ctx := context.Background()
	svc, sp, proj := restoreFixture(t)
	c := restoreMk(t, svc, sp, proj.ID, "C", "")
	setStatus(t, svc, sp, c.ID, ContribRewarded, "user-1")

	if err := svc.ArchiveContribution(ctx, sp, c.ID, "u"); err != nil {
		t.Fatal(err)
	}
	got, _ := svc.GetContribution(ctx, sp, c.ID)
	if got.ArchivedFrom != ContribRewarded {
		t.Fatalf("archived_from = %q, want rewarded", got.ArchivedFrom)
	}
	if err := svc.RestoreContribution(ctx, sp, c.ID, "restorer"); err != nil {
		t.Fatalf("RestoreContribution: %v", err)
	}
	mustStatus(t, svc, sp, c.ID, ContribRewarded)
	got, _ = svc.GetContribution(ctx, sp, c.ID)
	if got.ArchivedFrom != "" || got.ArchivedVia != "" {
		t.Errorf("archive markers not cleared: %+v", got)
	}
	if err := svc.RestoreContribution(ctx, sp, c.ID, "u"); err == nil {
		t.Error("restoring a non-archived contribution should fail")
	}
}

func TestRestoreContribution_LegacyRecordFallsBackToDefault(t *testing.T) {
	ctx := context.Background()
	svc, sp, proj := restoreFixture(t)
	unassigned := restoreMk(t, svc, sp, proj.ID, "U", "")
	assigned := restoreMk(t, svc, sp, proj.ID, "A", "")
	// Records archived before archived_from existed carry no marker.
	setStatus(t, svc, sp, unassigned.ID, ContribArchived, "")
	setStatus(t, svc, sp, assigned.ID, ContribArchived, "user-1")

	if err := svc.RestoreContribution(ctx, sp, unassigned.ID, "u"); err != nil {
		t.Fatal(err)
	}
	if err := svc.RestoreContribution(ctx, sp, assigned.ID, "u"); err != nil {
		t.Fatal(err)
	}
	mustStatus(t, svc, sp, unassigned.ID, ContribConfirmed)
	mustStatus(t, svc, sp, assigned.ID, ContribAssigned)
}

func TestRestoreContribution_CascadedParentRestoresTaggedChildrenOnly(t *testing.T) {
	ctx := context.Background()
	svc, sp, proj := restoreFixture(t)
	parent := restoreMk(t, svc, sp, proj.ID, "Parent", "")
	cascaded := restoreMk(t, svc, sp, proj.ID, "Cascaded", parent.ID)
	paid := restoreMk(t, svc, sp, proj.ID, "Paid", parent.ID)
	independent := restoreMk(t, svc, sp, proj.ID, "Independent", parent.ID)
	grand := restoreMk(t, svc, sp, proj.ID, "Grand", cascaded.ID)
	setStatus(t, svc, sp, paid.ID, ContribRewarded, "user-2")

	// The independent child is archived on its own, before the parent.
	if err := svc.ArchiveContribution(ctx, sp, independent.ID, "u"); err != nil {
		t.Fatal(err)
	}
	if err := svc.ArchiveContribution(ctx, sp, parent.ID, "u"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{parent.ID, cascaded.ID, independent.ID, grand.ID} {
		mustStatus(t, svc, sp, id, ContribArchived)
	}
	// Rewarded children are never archived by the cascade (#845).
	mustStatus(t, svc, sp, paid.ID, ContribRewarded)
	if c, _ := svc.GetContribution(ctx, sp, cascaded.ID); c.ArchivedVia != parent.ID {
		t.Errorf("cascaded child archived_via = %q, want parent id", c.ArchivedVia)
	}
	if c, _ := svc.GetContribution(ctx, sp, independent.ID); c.ArchivedVia != "" {
		t.Errorf("independent child must not be tagged, got %q", c.ArchivedVia)
	}

	if err := svc.RestoreContribution(ctx, sp, parent.ID, "u"); err != nil {
		t.Fatalf("RestoreContribution: %v", err)
	}
	// All were freshly created, so they return to created (their prior status).
	mustStatus(t, svc, sp, parent.ID, ContribCreated)
	mustStatus(t, svc, sp, cascaded.ID, ContribCreated)
	mustStatus(t, svc, sp, grand.ID, ContribCreated)
	mustStatus(t, svc, sp, paid.ID, ContribRewarded)
	mustStatus(t, svc, sp, independent.ID, ContribArchived)
}

func TestRestoreContribution_ChildOfArchivedParentRejected(t *testing.T) {
	ctx := context.Background()
	svc, sp, proj := restoreFixture(t)
	parent := restoreMk(t, svc, sp, proj.ID, "Parent", "")
	child := restoreMk(t, svc, sp, proj.ID, "Child", parent.ID)
	if err := svc.ArchiveContribution(ctx, sp, parent.ID, "u"); err != nil {
		t.Fatal(err)
	}
	if err := svc.RestoreContribution(ctx, sp, child.ID, "u"); err == nil {
		t.Fatal("restoring a child while its parent is archived should fail")
	}
	mustStatus(t, svc, sp, child.ID, ContribArchived)
}

func TestRestoreContribution_InvalidatesPlanSignOffAndLogs(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	sp := "s"
	proj, plan, _ := setupPlanWithMilestone(ctx, t, svc, sp)
	c := restoreMk(t, svc, sp, proj.ID, "Task", "")
	if err := svc.ArchiveContribution(ctx, sp, c.ID, "u"); err != nil {
		t.Fatal(err)
	}
	// Simulate a re-signed plan, then restore.
	p, _ := svc.GetImplementationPlan(ctx, sp, plan.ID)
	p.SignedOff = true
	if err := svc.SaveImplementationPlan(ctx, sp, p); err != nil {
		t.Fatal(err)
	}
	if err := svc.RestoreContribution(ctx, sp, c.ID, "restorer-1"); err != nil {
		t.Fatal(err)
	}
	p, _ = svc.GetImplementationPlan(ctx, sp, plan.ID)
	if p.SignedOff {
		t.Error("restore must invalidate plan sign-off")
	}
	last := p.ChangeLog[len(p.ChangeLog)-1]
	if last.Kind != "contribution_restored" || last.ContributionID != c.ID || last.ChangedBy != "restorer-1" {
		t.Errorf("unexpected change-log entry: %+v", last)
	}
}

func TestTransitionContribution_RejectsArchivedSource(t *testing.T) {
	ctx := context.Background()
	svc, sp, proj := restoreFixture(t)
	c := restoreMk(t, svc, sp, proj.ID, "C", "")
	if err := svc.ArchiveContribution(ctx, sp, c.ID, "u"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.TransitionContribution(ctx, sp, c.ID, ContribConfirmed); err == nil {
		t.Error("generic transition out of archived must be rejected (use restore)")
	}
}
