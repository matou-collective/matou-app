// backend/internal/contributions/auto_submit_parent_test.go
package contributions

import (
	"context"
	"testing"
	"time"
)

// autoSubmitFixture builds a signed-off plan with one milestone, an assigned
// parent contribution in it, and n sub-contributions that are each `approved`
// (ready to be signed off).
type autoSubmitFixture struct {
	svc    *Service
	ctx    context.Context
	space  string
	planID string
	ms     *Milestone
	parent *Contribution
	subs   []*Contribution
}

func newAutoSubmitFixture(t *testing.T, n int) *autoSubmitFixture {
	t.Helper()
	ctx := context.Background()
	svc := NewService(NewMockStore())
	space := "s"
	proj, plan, ms := setupPlanWithMilestone(ctx, t, svc, space)

	mk := func(title, parentID, msID string) *Contribution {
		c, err := svc.CreateContribution(ctx, space, &CreateContributionRequest{
			ProjectID: proj.ID, Title: title, Description: "d",
			ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
			CreatedBy: "lead", Objectives: []string{"o"}, Deliverables: []string{"d"},
			AcceptanceCriteria: []string{"a"}, SkillRequirements: []string{"s"},
			ParentContributionID: parentID, MilestoneID: msID,
		})
		if err != nil {
			t.Fatalf("create %s: %v", title, err)
		}
		return c
	}
	parent := mk("Parent", "", ms.MilestoneID)
	f := &autoSubmitFixture{svc: svc, ctx: ctx, space: space, planID: plan.ID, ms: ms}
	for i := 0; i < n; i++ {
		sub := mk("Sub", parent.ID, "")
		sub.Status = ContribApproved
		sub.ActualCost = 10
		if err := svc.SaveContribution(ctx, space, sub); err != nil {
			t.Fatal(err)
		}
		f.subs = append(f.subs, sub)
	}
	parent, _ = svc.GetContribution(ctx, space, parent.ID)
	parent.Status = ContribAssigned
	parent.AssignedContributorID = "contributor-1"
	if err := svc.SaveContribution(ctx, space, parent); err != nil {
		t.Fatal(err)
	}
	f.parent = parent

	p, _ := svc.GetImplementationPlan(ctx, space, plan.ID)
	p.SignedOff = true
	now := time.Now()
	p.SignedOffAt = &now
	p.ChangeLog = nil
	if err := svc.SaveImplementationPlan(ctx, space, p); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *autoSubmitFixture) signOff(t *testing.T, i int) {
	t.Helper()
	if _, err := f.svc.SignOffContribution(f.ctx, f.space, f.subs[i].ID, "steward", nil); err != nil {
		t.Fatalf("sign off sub %d: %v", i, err)
	}
}

func (f *autoSubmitFixture) parentStatus(t *testing.T) *Contribution {
	t.Helper()
	p, err := f.svc.GetContribution(f.ctx, f.space, f.parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestAutoSubmitParent_LastChildSignedOff(t *testing.T) {
	f := newAutoSubmitFixture(t, 2)
	f.signOff(t, 0)
	if got := f.parentStatus(t).Status; got != ContribAssigned {
		t.Fatalf("parent after first child = %s, want assigned", got)
	}
	f.signOff(t, 1)
	p := f.parentStatus(t)
	if p.Status != ContribNeedsReview {
		t.Fatalf("parent status = %s, want needs_review", p.Status)
	}
	if p.CompletionNotes != autoSubmitParentSystemNote {
		t.Errorf("completion notes = %q", p.CompletionNotes)
	}
	if len(p.EvidenceURLs) != 0 {
		t.Errorf("no evidence should be invented, got %v", p.EvidenceURLs)
	}
	if p.ActualCost != 20 {
		t.Errorf("actual cost = %v, want 20 (sum of children)", p.ActualCost)
	}
}

func TestAutoSubmitParent_ChangeLogEntry(t *testing.T) {
	f := newAutoSubmitFixture(t, 1)
	f.signOff(t, 0)
	plan, _ := f.svc.GetImplementationPlan(f.ctx, f.space, f.planID)
	if len(plan.ChangeLog) != 1 {
		t.Fatalf("change log entries = %d, want 1", len(plan.ChangeLog))
	}
	e := plan.ChangeLog[0]
	if e.Kind != "contribution_auto_submitted" || e.ContributionID != f.parent.ID || e.ChangedBy != "system" {
		t.Errorf("unexpected entry: %+v", e)
	}
	if !plan.SignedOff {
		t.Error("auto-submit must not unsign the plan")
	}
}

func TestAutoSubmitParent_LastChildRewarded(t *testing.T) {
	f := newAutoSubmitFixture(t, 2)
	// Parent is not yet assigned while the children are completed.
	p := f.parentStatus(t)
	p.Status = ContribConfirmed
	_ = f.svc.SaveContribution(f.ctx, f.space, p)
	f.signOff(t, 0)
	f.signOff(t, 1)
	if got := f.parentStatus(t).Status; got != ContribConfirmed {
		t.Fatalf("non-assigned parent moved to %s", got)
	}
	p = f.parentStatus(t)
	p.Status = ContribAssigned
	_ = f.svc.SaveContribution(f.ctx, f.space, p)
	if _, err := f.svc.RewardContribution(f.ctx, f.space, f.subs[0].ID, "admin", nil); err != nil {
		t.Fatal(err)
	}
	if got := f.parentStatus(t).Status; got != ContribNeedsReview {
		t.Fatalf("parent status = %s, want needs_review", got)
	}
}

func TestAutoSubmitParent_OneChildStillOpen(t *testing.T) {
	f := newAutoSubmitFixture(t, 2)
	f.signOff(t, 0)
	if got := f.parentStatus(t).Status; got != ContribAssigned {
		t.Fatalf("parent status = %s, want assigned", got)
	}
}

func TestAutoSubmitParent_ArchivedChildIgnored(t *testing.T) {
	f := newAutoSubmitFixture(t, 2)
	arch, _ := f.svc.GetContribution(f.ctx, f.space, f.subs[1].ID)
	arch.Status = ContribArchived
	_ = f.svc.SaveContribution(f.ctx, f.space, arch)
	f.signOff(t, 0)
	if got := f.parentStatus(t).Status; got != ContribNeedsReview {
		t.Fatalf("parent status = %s, want needs_review (archived child ignored)", got)
	}
}

func TestAutoSubmitParent_ParentAlreadyPastAssigned(t *testing.T) {
	f := newAutoSubmitFixture(t, 1)
	p := f.parentStatus(t)
	p.Status = ContribApproved
	p.CompletionNotes = "manual"
	_ = f.svc.SaveContribution(f.ctx, f.space, p)
	f.signOff(t, 0)
	got := f.parentStatus(t)
	if got.Status != ContribApproved || got.CompletionNotes != "manual" {
		t.Fatalf("parent changed: %s %q", got.Status, got.CompletionNotes)
	}
	plan, _ := f.svc.GetImplementationPlan(f.ctx, f.space, f.planID)
	if len(plan.ChangeLog) != 0 {
		t.Errorf("unexpected change log entries: %d", len(plan.ChangeLog))
	}
}

func TestAutoSubmitParent_NoChildrenUntouched(t *testing.T) {
	f := newAutoSubmitFixture(t, 1)
	// A childless top-level contribution has no parent hook to fire.
	solo := f.subs[0]
	solo.ParentContributionID = ""
	_ = f.svc.SaveContribution(f.ctx, f.space, solo)
	f.signOff(t, 0)
	if got := f.parentStatus(t).Status; got != ContribAssigned {
		t.Fatalf("parent status = %s, want assigned", got)
	}
}
