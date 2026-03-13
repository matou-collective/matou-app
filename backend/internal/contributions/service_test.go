// backend/internal/contributions/service_test.go
package contributions

import (
	"context"
	"testing"
	"time"
)

func TestService_CreateProposal(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	p, err := svc.CreateProposal(ctx, "space-1", &CreateProposalRequest{
		ProposerID:       "user-1",
		Title:            "Build website",
		Types:            []ProposalType{ProposalTypeTechnical},
		Priority:         PriorityMedium,
		Description:      "Build a new website",
		ProblemStatement: "No website exists",
		Solution:         "Build one",
		ExpectedOutcomes: []string{"Website launched"},
		EstimatedBudget:  "$5000",
		Timeline:         "4 weeks",
	})
	if err != nil {
		t.Fatalf("CreateProposal failed: %v", err)
	}
	if p.Status != ProposalDraft {
		t.Errorf("expected draft status, got %s", p.Status)
	}
	if p.ID == "" {
		t.Error("expected non-empty ID")
	}
	if p.ProposerID != "user-1" {
		t.Errorf("expected proposer_id user-1, got %s", p.ProposerID)
	}
}

func TestService_TransitionProposal(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	p, _ := svc.CreateProposal(ctx, "space-1", &CreateProposalRequest{
		ProposerID: "user-1", Title: "Test", Types: []ProposalType{ProposalTypeTechnical},
		Priority: PriorityLow, Description: "d", ProblemStatement: "p",
		Solution: "s", ExpectedOutcomes: []string{"o"}, EstimatedBudget: "$1", Timeline: "1w",
	})

	updated, err := svc.TransitionProposal(ctx, "space-1", p.ID, ProposalSubmitted)
	if err != nil {
		t.Fatalf("TransitionProposal failed: %v", err)
	}
	if updated.Status != ProposalSubmitted {
		t.Errorf("expected submitted, got %s", updated.Status)
	}

	// Invalid transition
	_, err = svc.TransitionProposal(ctx, "space-1", p.ID, ProposalApproved)
	if err == nil {
		t.Error("expected error for invalid transition")
	}
}

func TestService_AddEndorsement(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	p, _ := svc.CreateProposal(ctx, "space-1", &CreateProposalRequest{
		ProposerID: "user-1", Title: "Test", Types: []ProposalType{ProposalTypeTechnical},
		Priority: PriorityLow, Description: "d", ProblemStatement: "p",
		Solution: "s", ExpectedOutcomes: []string{"o"}, EstimatedBudget: "$1", Timeline: "1w",
	})

	// Move to endorsing
	svc.TransitionProposal(ctx, "space-1", p.ID, ProposalSubmitted)
	svc.TransitionProposal(ctx, "space-1", p.ID, ProposalEndorsing)

	err := svc.AddEndorsement(ctx, "space-1", p.ID, &Endorsement{
		EndorserID: "user-2",
		EndorsedAt: time.Now(),
		Comment:    "Looks good",
	})
	if err != nil {
		t.Fatalf("AddEndorsement failed: %v", err)
	}

	endorsements, err := svc.GetEndorsements(ctx, "space-1", p.ID)
	if err != nil {
		t.Fatalf("GetEndorsements failed: %v", err)
	}
	if len(endorsements) != 1 {
		t.Errorf("expected 1 endorsement, got %d", len(endorsements))
	}
}

func TestService_CreateProject(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	p, err := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title:       "Website Rebuild",
		Description: "Rebuild the community website",
		CreatedBy:   "admin-1",
	})
	if err != nil {
		t.Fatalf("CreateProject failed: %v", err)
	}
	if p.Status != ProjectCreated {
		t.Errorf("expected created status, got %s", p.Status)
	}
	if p.CreatedBy != "admin-1" {
		t.Errorf("expected created_by admin-1, got %s", p.CreatedBy)
	}
}

func TestService_LinkProposalToProject(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	proj, _ := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title: "Project", Description: "Test", CreatedBy: "admin-1",
	})

	updated, err := svc.LinkProposalToProject(ctx, "space-1", proj.ID, "proposal-123")
	if err != nil {
		t.Fatalf("LinkProposal failed: %v", err)
	}
	if len(updated.ProposalIDs) != 1 || updated.ProposalIDs[0] != "proposal-123" {
		t.Errorf("expected proposal-123 in proposal_ids, got %v", updated.ProposalIDs)
	}
}

func TestService_AutoCreateProjectOnApproval(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	prop, _ := svc.CreateProposal(ctx, "space-1", &CreateProposalRequest{
		ProposerID: "user-1", Title: "Test", Types: []ProposalType{ProposalTypeTechnical},
		Priority: PriorityLow, Description: "d", ProblemStatement: "p",
		Solution: "s", ExpectedOutcomes: []string{"o"}, EstimatedBudget: "$1", Timeline: "1w",
	})

	project, err := svc.AutoCreateProjectForProposal(ctx, "space-1", prop.ID, "admin-1")
	if err != nil {
		t.Fatalf("AutoCreateProject failed: %v", err)
	}
	if len(project.ProposalIDs) != 1 || project.ProposalIDs[0] != prop.ID {
		t.Errorf("expected proposal linked, got %v", project.ProposalIDs)
	}
	if project.Title != prop.Title {
		t.Errorf("expected title from proposal, got %s", project.Title)
	}
}

func TestService_UpdateProject(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	proj, _ := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title: "Old Title", Description: "Test", CreatedBy: "admin-1",
	})

	updated, err := svc.UpdateProject(ctx, "space-1", proj.ID, &UpdateProjectRequest{
		Title:       "New Title",
		Description: "Updated description",
	})
	if err != nil {
		t.Fatalf("UpdateProject failed: %v", err)
	}
	if updated.Title != "New Title" {
		t.Errorf("expected New Title, got %s", updated.Title)
	}
}

func TestService_DeleteProject_NoActivePlans(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	proj, _ := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title: "To Delete", Description: "Test", CreatedBy: "admin-1",
	})

	err := svc.DeleteProject(ctx, "space-1", proj.ID)
	if err != nil {
		t.Fatalf("DeleteProject failed: %v", err)
	}

	_, err = svc.GetProject(ctx, "space-1", proj.ID)
	if err == nil {
		t.Error("expected error after deletion")
	}
}

func TestService_CreateDecisionPlan(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	dp, err := svc.CreateDecisionPlan(ctx, "space-1", &CreateDecisionPlanRequest{
		ProposalID:        "prop-1",
		Title:             "Governance Path",
		Description:       "Decision plan for proposal",
		Objectives:        []string{"Get elder approval"},
		ExpectedOutcomes:  []string{"Approved"},
		ProposalLeadID:    "lead-1",
		ProposalStewardID: "steward-1",
	})
	if err != nil {
		t.Fatalf("CreateDecisionPlan failed: %v", err)
	}
	if dp.Status != DecisionPlanDrafted {
		t.Errorf("expected drafted, got %s", dp.Status)
	}
	if dp.ProposalID != "prop-1" {
		t.Errorf("expected prop-1, got %s", dp.ProposalID)
	}
}

func TestService_TransitionDecisionPlan(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	dp, _ := svc.CreateDecisionPlan(ctx, "space-1", &CreateDecisionPlanRequest{
		ProposalID: "prop-1", Title: "Test", Description: "d",
		Objectives: []string{"o"}, ExpectedOutcomes: []string{"o"},
		ProposalLeadID: "lead-1", ProposalStewardID: "steward-1",
	})

	updated, err := svc.TransitionDecisionPlan(ctx, "space-1", dp.ID, DecisionPlanSubmitted)
	if err != nil {
		t.Fatalf("TransitionDecisionPlan failed: %v", err)
	}
	if updated.Status != DecisionPlanSubmitted {
		t.Errorf("expected submitted, got %s", updated.Status)
	}

	// Invalid: submitted → drafted (no such transition)
	_, err = svc.TransitionDecisionPlan(ctx, "space-1", dp.ID, DecisionPlanDrafted)
	if err == nil {
		t.Error("expected error for invalid transition")
	}
}

func TestService_AddGovernanceAction(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	dp, _ := svc.CreateDecisionPlan(ctx, "space-1", &CreateDecisionPlanRequest{
		ProposalID: "prop-1", Title: "Test", Description: "d",
		Objectives: []string{"o"}, ExpectedOutcomes: []string{"o"},
		ProposalLeadID: "lead-1", ProposalStewardID: "steward-1",
	})

	action, err := svc.AddGovernanceAction(ctx, "space-1", &CreateGovernanceActionRequest{
		DecisionPlanID: dp.ID,
		House:          HouseElderCouncil,
		ActionType:     ActionDecision,
		Description:    "Elder veto check",
	})
	if err != nil {
		t.Fatalf("AddGovernanceAction failed: %v", err)
	}
	if action.Status != GovActionPlanned {
		t.Errorf("expected planned, got %s", action.Status)
	}
	if action.DecisionPlanID != dp.ID {
		t.Errorf("expected decision_plan_id %s, got %s", dp.ID, action.DecisionPlanID)
	}
}

func TestService_CompleteGovernanceAction(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	action, _ := svc.AddGovernanceAction(ctx, "space-1", &CreateGovernanceActionRequest{
		DecisionPlanID: "dp-1",
		House:          HouseElderCouncil,
		ActionType:     ActionDecision,
		Description:    "Elder veto check",
	})

	updated, err := svc.CompleteGovernanceAction(ctx, "space-1", action.ID, OutcomeNoVeto)
	if err != nil {
		t.Fatalf("CompleteGovernanceAction failed: %v", err)
	}
	if updated.Status != GovActionCompleted {
		t.Errorf("expected completed, got %s", updated.Status)
	}
	if updated.Outcome != OutcomeNoVeto {
		t.Errorf("expected no_veto, got %s", updated.Outcome)
	}
}

func TestService_CreateImplementationPlan(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	ip, err := svc.CreateImplementationPlan(ctx, "space-1", &CreateImplementationPlanRequest{
		ProjectID:        "proj-1",
		Title:            "Phase 1 Implementation",
		TotalBudget:      "$10000",
		ProjectLeadID:    "lead-1",
		ProjectStewardID: "steward-1",
	})
	if err != nil {
		t.Fatalf("failed: %v", err)
	}
	if ip.ProjectID != "proj-1" {
		t.Errorf("expected proj-1, got %s", ip.ProjectID)
	}
	if ip.ProjectStewardID != "steward-1" {
		t.Errorf("expected steward-1, got %s", ip.ProjectStewardID)
	}
}

func TestService_AddMilestone(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	ip, _ := svc.CreateImplementationPlan(ctx, "space-1", &CreateImplementationPlanRequest{
		ProjectID: "proj-1", Title: "Plan", TotalBudget: "$1",
		ProjectLeadID: "lead-1", ProjectStewardID: "steward-1",
	})

	ms, err := svc.AddMilestone(ctx, "space-1", &CreateMilestoneRequest{
		ImplementationPlanID: ip.ID,
		Title:                "Design Phase",
		Duration:             "2 weeks",
	})
	if err != nil {
		t.Fatalf("failed: %v", err)
	}
	if ms.ImplementationPlanID != ip.ID {
		t.Errorf("expected plan ID %s, got %s", ip.ID, ms.ImplementationPlanID)
	}
}

func TestService_CreateContribution(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, err := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID:          "proj-1",
		Title:              "Build landing page",
		Description:        "Create the main landing page",
		ContributionType:   ProposalTypeTechnical,
		Priority:           PriorityMedium,
		CreatedBy:          "lead-1",
		Objectives:         []string{"Page deployed"},
		Deliverables:       []string{"HTML/CSS page"},
		AcceptanceCriteria: []string{"Responsive design"},
		SkillRequirements:  []string{"frontend"},
	})
	if err != nil {
		t.Fatalf("failed: %v", err)
	}
	if c.Status != ContribCreated {
		t.Errorf("expected created, got %s", c.Status)
	}
}

func TestService_ContributionLifecycle(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})

	// Full lifecycle: created → confirmed → assigned → needs_review → approved → signed_off
	transitions := []ContributionStatus{
		ContribConfirmed, ContribAssigned, ContribNeedsReview,
		ContribApproved, ContribSignedOff,
	}
	for _, status := range transitions {
		updated, err := svc.TransitionContribution(ctx, "space-1", c.ID, status)
		if err != nil {
			t.Fatalf("transition to %s failed: %v", status, err)
		}
		if updated.Status != status {
			t.Errorf("expected %s, got %s", status, updated.Status)
		}
	}
}

func TestService_ContributionIncompleteFlow(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})

	// created → confirmed → assigned → needs_review → incomplete → assigned
	for _, s := range []ContributionStatus{ContribConfirmed, ContribAssigned, ContribNeedsReview, ContribIncomplete, ContribAssigned} {
		c, _ = svc.TransitionContribution(ctx, "space-1", c.ID, s)
	}
	if c.Status != ContribAssigned {
		t.Errorf("expected assigned after incomplete loop, got %s", c.Status)
	}
}

func TestService_ContributionDeclinedFlow(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})

	for _, s := range []ContributionStatus{ContribConfirmed, ContribAssigned, ContribNeedsReview, ContribDeclined, ContribArchived} {
		c, _ = svc.TransitionContribution(ctx, "space-1", c.ID, s)
	}
	if c.Status != ContribArchived {
		t.Errorf("expected archived after declined, got %s", c.Status)
	}
}

func TestService_RegisterInterest(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})
	// Move to confirmed (eligible for registration)
	svc.TransitionContribution(ctx, "space-1", c.ID, ContribConfirmed)

	reg, err := svc.RegisterInterest(ctx, "space-1", c.ID, "user-2", "I have frontend experience")
	if err != nil {
		t.Fatalf("RegisterInterest failed: %v", err)
	}
	if reg.ContributionID != c.ID {
		t.Errorf("expected contribution ID %s, got %s", c.ID, reg.ContributionID)
	}

	regs, err := svc.ListRegistrations(ctx, "space-1", c.ID)
	if err != nil {
		t.Fatalf("ListRegistrations failed: %v", err)
	}
	if len(regs) != 1 {
		t.Errorf("expected 1 registration, got %d", len(regs))
	}
}

func TestService_RegisterInterest_WrongStatus(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})
	// Still in "created" status — not eligible for registration
	_, err := svc.RegisterInterest(ctx, "space-1", c.ID, "user-2", "Interested")
	if err == nil {
		t.Error("expected error registering interest on non-confirmed contribution")
	}
}

func TestService_AssignFromRegistration(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	c, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})
	svc.TransitionContribution(ctx, "space-1", c.ID, ContribConfirmed)
	svc.RegisterInterest(ctx, "space-1", c.ID, "user-2", "Interested")

	updated, err := svc.AssignContributor(ctx, "space-1", c.ID, "user-2")
	if err != nil {
		t.Fatalf("AssignContributor failed: %v", err)
	}
	if updated.AssignedContributorID != "user-2" {
		t.Errorf("expected user-2 assigned, got %s", updated.AssignedContributorID)
	}
	if updated.Status != ContribAssigned {
		t.Errorf("expected assigned status, got %s", updated.Status)
	}
}

func TestService_DeriveProjectStatus(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	proj, _ := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title: "Test", Description: "Test", CreatedBy: "admin-1",
	})

	// No implementation plans → created
	status := svc.DeriveProjectStatus(ctx, "space-1", proj.ID)
	if status != ProjectCreated {
		t.Errorf("expected created with no plans, got %s", status)
	}

	// Add an implementation plan with status "created"
	ip, _ := svc.CreateImplementationPlan(ctx, "space-1", &CreateImplementationPlanRequest{
		ProjectID: proj.ID, Title: "Plan 1", TotalBudget: "$1",
		ProjectLeadID: "l", ProjectStewardID: "s",
	})
	_ = ip

	status = svc.DeriveProjectStatus(ctx, "space-1", proj.ID)
	if status != ProjectActive {
		t.Errorf("expected active with one plan, got %s", status)
	}
}
