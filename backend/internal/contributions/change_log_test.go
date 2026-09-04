// backend/internal/contributions/change_log_test.go
package contributions

import (
	"context"
	"fmt"
	"testing"
)

// failingSaveStore wraps a MockObjectStore and fails Save for a given
// objectType, used to verify that change-log recording failures (which ride
// along on the same save as the underlying mutation at best-effort call
// sites) don't fail the mutation itself.
type failingSaveStore struct {
	*MockObjectStore
	failType string
}

func (f *failingSaveStore) Save(spaceID, objectID, objectType string, data interface{}) error {
	if objectType == f.failType {
		return fmt.Errorf("simulated save failure for %s", objectType)
	}
	return f.MockObjectStore.Save(spaceID, objectID, objectType, data)
}

func setupPlanWithMilestone(ctx context.Context, t *testing.T, svc *Service, spaceID string) (*Project, *ImplementationPlan, *Milestone) {
	t.Helper()
	proj, err := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	plan, err := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	if err != nil {
		t.Fatalf("CreateImplementationPlan: %v", err)
	}
	ms, err := svc.AddMilestone(ctx, spaceID, "creator-1", &CreateMilestoneRequest{
		ImplementationPlanID: plan.ID, Title: "Design Phase", Duration: "1w",
	})
	if err != nil {
		t.Fatalf("AddMilestone: %v", err)
	}
	return proj, plan, ms
}

func TestAddMilestone_RecordsChangeLogEntry(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"

	_, plan, ms := setupPlanWithMilestone(ctx, t, svc, spaceID)

	gotPlan, err := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if err != nil {
		t.Fatalf("GetImplementationPlan: %v", err)
	}
	if len(gotPlan.ChangeLog) != 1 {
		t.Fatalf("expected 1 change log entry, got %d", len(gotPlan.ChangeLog))
	}
	entry := gotPlan.ChangeLog[0]
	if entry.Kind != "milestone_added" {
		t.Errorf("kind = %q, want milestone_added", entry.Kind)
	}
	if entry.MilestoneID != ms.MilestoneID {
		t.Errorf("milestone_id = %q, want %q", entry.MilestoneID, ms.MilestoneID)
	}
	if entry.MilestoneTitle != "Design Phase" {
		t.Errorf("milestone_title = %q, want Design Phase", entry.MilestoneTitle)
	}
	if entry.ChangedBy != "creator-1" {
		t.Errorf("changed_by = %q, want creator-1", entry.ChangedBy)
	}
	if entry.ID == "" {
		t.Error("expected non-empty entry ID")
	}
	if entry.ChangedAt.IsZero() {
		t.Error("expected non-zero ChangedAt")
	}
}

func TestArchiveMilestone_RecordsChangeLogEntry(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"

	_, plan, ms := setupPlanWithMilestone(ctx, t, svc, spaceID)

	if err := svc.ArchiveMilestone(ctx, spaceID, ms.MilestoneID, "archiver-1"); err != nil {
		t.Fatalf("ArchiveMilestone: %v", err)
	}

	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	// index 0 = milestone_added (from setup), index 1 = milestone_archived
	if len(gotPlan.ChangeLog) != 2 {
		t.Fatalf("expected 2 change log entries, got %d", len(gotPlan.ChangeLog))
	}
	entry := gotPlan.ChangeLog[1]
	if entry.Kind != "milestone_archived" {
		t.Errorf("kind = %q, want milestone_archived", entry.Kind)
	}
	if entry.MilestoneID != ms.MilestoneID {
		t.Errorf("milestone_id = %q, want %q", entry.MilestoneID, ms.MilestoneID)
	}
	if entry.MilestoneTitle != "Design Phase" {
		t.Errorf("milestone_title = %q, want Design Phase (captured before archiving)", entry.MilestoneTitle)
	}
	if entry.ChangedBy != "archiver-1" {
		t.Errorf("changed_by = %q, want archiver-1", entry.ChangedBy)
	}
}

func TestCreateContribution_RecordsChangeLogEntry(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"

	proj, plan, ms := setupPlanWithMilestone(ctx, t, svc, spaceID)

	contrib, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, MilestoneID: ms.MilestoneID, Title: "Build page", Description: "d",
		ContributionType: "development", CreatedBy: "author-1",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	if err != nil {
		t.Fatalf("CreateContribution: %v", err)
	}

	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	// index 0 = milestone_added (from setup), index 1 = contribution_added
	if len(gotPlan.ChangeLog) != 2 {
		t.Fatalf("expected 2 change log entries, got %d", len(gotPlan.ChangeLog))
	}
	entry := gotPlan.ChangeLog[1]
	if entry.Kind != "contribution_added" {
		t.Errorf("kind = %q, want contribution_added", entry.Kind)
	}
	if entry.ContributionID != contrib.ID {
		t.Errorf("contribution_id = %q, want %q", entry.ContributionID, contrib.ID)
	}
	if entry.ContributionTitle != "Build page" {
		t.Errorf("contribution_title = %q, want Build page", entry.ContributionTitle)
	}
	if entry.MilestoneID != ms.MilestoneID {
		t.Errorf("milestone_id = %q, want %q", entry.MilestoneID, ms.MilestoneID)
	}
	if entry.ChangedBy != "author-1" {
		t.Errorf("changed_by = %q, want author-1 (contribution's CreatedBy)", entry.ChangedBy)
	}
}

func TestArchiveContribution_RecordsChangeLogEntry(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"

	proj, plan, _ := setupPlanWithMilestone(ctx, t, svc, spaceID)

	contrib, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "Standalone task", Description: "d",
		ContributionType: "development", CreatedBy: "author-1",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	if err != nil {
		t.Fatalf("CreateContribution: %v", err)
	}

	if err := svc.ArchiveContribution(ctx, spaceID, contrib.ID, "remover-1"); err != nil {
		t.Fatalf("ArchiveContribution: %v", err)
	}

	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	last := gotPlan.ChangeLog[len(gotPlan.ChangeLog)-1]
	if last.Kind != "contribution_removed" {
		t.Errorf("kind = %q, want contribution_removed", last.Kind)
	}
	if last.ContributionID != contrib.ID {
		t.Errorf("contribution_id = %q, want %q", last.ContributionID, contrib.ID)
	}
	if last.ChangedBy != "remover-1" {
		t.Errorf("changed_by = %q, want remover-1", last.ChangedBy)
	}
}

func TestSignOffPlan_ClearsChangeLog(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"

	proj, plan, ms := setupPlanWithMilestone(ctx, t, svc, spaceID)
	if _, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, MilestoneID: ms.MilestoneID, Title: "C", Description: "d",
		ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	}); err != nil {
		t.Fatalf("CreateContribution: %v", err)
	}

	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if len(gotPlan.ChangeLog) == 0 {
		t.Fatal("expected change log entries to exist before sign-off")
	}

	signed, err := svc.SignOffPlan(ctx, spaceID, plan.ID, "steward-1", nil)
	if err != nil {
		t.Fatalf("SignOffPlan: %v", err)
	}
	if len(signed.ChangeLog) != 0 {
		t.Errorf("expected change log to be cleared on sign-off, got %d entries", len(signed.ChangeLog))
	}

	gotPlan, _ = svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if len(gotPlan.ChangeLog) != 0 {
		t.Errorf("expected persisted change log to be cleared, got %d entries", len(gotPlan.ChangeLog))
	}

	// A subsequent mutation should accumulate fresh entries again.
	if err := svc.ArchiveMilestone(ctx, spaceID, ms.MilestoneID, "u"); err != nil {
		t.Fatalf("ArchiveMilestone: %v", err)
	}
	gotPlan, _ = svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if len(gotPlan.ChangeLog) != 1 {
		t.Errorf("expected 1 fresh change log entry after sign-off, got %d", len(gotPlan.ChangeLog))
	}
}

func TestPlanChangeLog_CapsAtMaxEntries(t *testing.T) {
	plan := &ImplementationPlan{ID: "ip-1"}
	for i := 0; i < maxPlanChangeLogEntries+10; i++ {
		appendPlanChange(plan, PlanChangeEntry{
			Kind:      "milestone_edited",
			ChangedBy: fmt.Sprintf("user-%d", i),
		})
	}
	if len(plan.ChangeLog) != maxPlanChangeLogEntries {
		t.Fatalf("expected change log capped at %d entries, got %d", maxPlanChangeLogEntries, len(plan.ChangeLog))
	}
	// The oldest entries should have been dropped — the first entry remaining
	// should be from the 11th append (index 10, 0-based) since we appended 10
	// extra beyond the cap.
	first := plan.ChangeLog[0]
	if first.ChangedBy != "user-10" {
		t.Errorf("expected oldest entries dropped, first remaining ChangedBy = %q, want user-10", first.ChangedBy)
	}
	last := plan.ChangeLog[len(plan.ChangeLog)-1]
	wantLast := fmt.Sprintf("user-%d", maxPlanChangeLogEntries+9)
	if last.ChangedBy != wantLast {
		t.Errorf("last entry ChangedBy = %q, want %q", last.ChangedBy, wantLast)
	}
}

func TestAddMilestone_RecordingFailureDoesNotFailMutation(t *testing.T) {
	ctx := context.Background()
	base := NewMockStore()
	spaceID := "s"

	setupSvc := NewService(base)
	proj, err := setupSvc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	plan, err := setupSvc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	if err != nil {
		t.Fatalf("CreateImplementationPlan: %v", err)
	}

	// AddMilestone's plan-refresh save (where the change-log entry is
	// recorded) is best-effort (`_ = s.store.Save(...)`), so a failure there
	// must not fail milestone creation itself.
	failing := &failingSaveStore{MockObjectStore: base, failType: "implementation_plan"}
	svc := NewService(failing)

	ms, err := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: plan.ID, Title: "M", Duration: "1w",
	})
	if err != nil {
		t.Fatalf("AddMilestone should not fail when the plan save (change-log recording) fails: %v", err)
	}
	if ms.MilestoneID == "" {
		t.Error("expected milestone to be created despite plan save failure")
	}

	// Milestone itself was saved (only the plan save, used for change-log
	// recording, was made to fail).
	got, err := svc.GetMilestone(ctx, spaceID, ms.MilestoneID)
	if err != nil {
		t.Fatalf("GetMilestone: %v", err)
	}
	if got.Title != "M" {
		t.Errorf("milestone title = %q, want M", got.Title)
	}
}

// newTestContributionReq returns a minimal valid CreateContributionRequest.
func newTestContributionReq(projectID, title string) *CreateContributionRequest {
	return &CreateContributionRequest{
		ProjectID:          projectID,
		Title:              title,
		Description:        "d",
		CreatedBy:          "creator-1",
		Objectives:         []string{"o"},
		Deliverables:       []string{"d"},
		AcceptanceCriteria: []string{"a"},
	}
}

func TestCreateSubContribution_RecordsChangeLogEntryUnderParentMilestone(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"

	proj, plan, ms := setupPlanWithMilestone(ctx, t, svc, spaceID)

	parentReq := newTestContributionReq(proj.ID, "Parent Work")
	parentReq.MilestoneID = ms.MilestoneID
	parent, err := svc.CreateContribution(ctx, spaceID, parentReq)
	if err != nil {
		t.Fatalf("CreateContribution parent: %v", err)
	}

	// Sub-contributions are created with parent_contribution set and NO
	// milestone_id (API convention). The change log must still attribute the
	// change to the parent's milestone.
	subReq := newTestContributionReq(proj.ID, "Sub Work")
	subReq.ParentContributionID = parent.ID
	sub, err := svc.CreateContribution(ctx, spaceID, subReq)
	if err != nil {
		t.Fatalf("CreateContribution sub: %v", err)
	}

	gotPlan, err := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if err != nil {
		t.Fatalf("GetImplementationPlan: %v", err)
	}
	var entry *PlanChangeEntry
	for i := range gotPlan.ChangeLog {
		if gotPlan.ChangeLog[i].ContributionID == sub.ID {
			entry = &gotPlan.ChangeLog[i]
		}
	}
	if entry == nil {
		t.Fatalf("expected a change log entry for sub-contribution %s, got %+v", sub.ID, gotPlan.ChangeLog)
	}
	if entry.Kind != "contribution_added" {
		t.Errorf("kind = %q, want contribution_added", entry.Kind)
	}
	if entry.MilestoneID != ms.MilestoneID {
		t.Errorf("milestone_id = %q, want %q (resolved via parent)", entry.MilestoneID, ms.MilestoneID)
	}
	if entry.MilestoneTitle != ms.Title {
		t.Errorf("milestone_title = %q, want %q", entry.MilestoneTitle, ms.Title)
	}
	if entry.ParentContributionID != parent.ID {
		t.Errorf("parent_contribution_id = %q, want %q", entry.ParentContributionID, parent.ID)
	}
	if entry.ParentContributionTitle != "Parent Work" {
		t.Errorf("parent_contribution_title = %q, want Parent Work", entry.ParentContributionTitle)
	}
}

func TestCreateSubContribution_InvalidatesPlanSignOff(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"

	proj, plan, ms := setupPlanWithMilestone(ctx, t, svc, spaceID)

	parentReq := newTestContributionReq(proj.ID, "Parent Work")
	parentReq.MilestoneID = ms.MilestoneID
	parentReq.Deadline = "2027-01-01"
	parent, err := svc.CreateContribution(ctx, spaceID, parentReq)
	if err != nil {
		t.Fatalf("CreateContribution parent: %v", err)
	}
	if _, err := svc.ConfirmContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("ConfirmContribution: %v", err)
	}
	if _, err := svc.SignOffPlan(ctx, spaceID, plan.ID, "signer-1", nil); err != nil {
		t.Fatalf("SignOffPlan: %v", err)
	}

	subReq := newTestContributionReq(proj.ID, "Sub Work")
	subReq.ParentContributionID = parent.ID
	if _, err := svc.CreateContribution(ctx, spaceID, subReq); err != nil {
		t.Fatalf("CreateContribution sub: %v", err)
	}

	gotPlan, err := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if err != nil {
		t.Fatalf("GetImplementationPlan: %v", err)
	}
	if gotPlan.SignedOff {
		t.Error("expected sub-contribution creation to invalidate plan sign-off")
	}
	if len(gotPlan.ChangeLog) != 1 {
		t.Fatalf("expected 1 change log entry after sign-off reset, got %d", len(gotPlan.ChangeLog))
	}
}

func TestArchiveSubContribution_RecordsChangeLogEntryUnderParentMilestone(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"

	proj, plan, ms := setupPlanWithMilestone(ctx, t, svc, spaceID)

	parentReq := newTestContributionReq(proj.ID, "Parent Work")
	parentReq.MilestoneID = ms.MilestoneID
	parent, err := svc.CreateContribution(ctx, spaceID, parentReq)
	if err != nil {
		t.Fatalf("CreateContribution parent: %v", err)
	}
	subReq := newTestContributionReq(proj.ID, "Sub Work")
	subReq.ParentContributionID = parent.ID
	sub, err := svc.CreateContribution(ctx, spaceID, subReq)
	if err != nil {
		t.Fatalf("CreateContribution sub: %v", err)
	}

	if err := svc.ArchiveContribution(ctx, spaceID, sub.ID, "archiver-1"); err != nil {
		t.Fatalf("ArchiveContribution: %v", err)
	}

	gotPlan, err := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if err != nil {
		t.Fatalf("GetImplementationPlan: %v", err)
	}
	var entry *PlanChangeEntry
	for i := range gotPlan.ChangeLog {
		if gotPlan.ChangeLog[i].Kind == "contribution_removed" && gotPlan.ChangeLog[i].ContributionID == sub.ID {
			entry = &gotPlan.ChangeLog[i]
		}
	}
	if entry == nil {
		t.Fatalf("expected contribution_removed entry for sub %s, got %+v", sub.ID, gotPlan.ChangeLog)
	}
	if entry.MilestoneID != ms.MilestoneID {
		t.Errorf("milestone_id = %q, want %q (resolved via parent)", entry.MilestoneID, ms.MilestoneID)
	}
	if entry.ParentContributionID != parent.ID {
		t.Errorf("parent_contribution_id = %q, want %q", entry.ParentContributionID, parent.ID)
	}
}
