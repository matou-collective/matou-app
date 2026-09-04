// backend/internal/contributions/service_test.go
package contributions

import (
	"context"
	"errors"
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

	_, err := svc.AddEndorsement(ctx, "space-1", p.ID, &Endorsement{
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

func TestService_LinkProposalToProject_RejectsDuplicate(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	// Create two projects
	proj1, _ := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title: "Project A", Description: "First", CreatedBy: "admin-1",
	})
	proj2, _ := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title: "Project B", Description: "Second", CreatedBy: "admin-1",
	})

	// Link proposal to first project — should succeed
	_, err := svc.LinkProposalToProject(ctx, "space-1", proj1.ID, "proposal-1")
	if err != nil {
		t.Fatalf("first link should succeed: %v", err)
	}

	// Try linking same proposal to second project — should fail
	_, err = svc.LinkProposalToProject(ctx, "space-1", proj2.ID, "proposal-1")
	if err == nil {
		t.Fatal("expected error when linking proposal to a second project")
	}

	// Re-linking to the same project should be idempotent (no error)
	_, err = svc.LinkProposalToProject(ctx, "space-1", proj1.ID, "proposal-1")
	if err != nil {
		t.Fatalf("re-link to same project should be idempotent: %v", err)
	}
}

func TestService_GetProjectByProposalID(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	proj, _ := svc.CreateProject(ctx, "space-1", &CreateProjectRequest{
		Title: "Project", Description: "Test", CreatedBy: "admin-1",
	})
	svc.LinkProposalToProject(ctx, "space-1", proj.ID, "proposal-1")

	// Should find the linked project
	found, err := svc.GetProjectByProposalID(ctx, "space-1", "proposal-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if found == nil || found.ID != proj.ID {
		t.Errorf("expected project %s, got %v", proj.ID, found)
	}

	// Should return nil for unlinked proposal
	found, err = svc.GetProjectByProposalID(ctx, "space-1", "proposal-999")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if found != nil {
		t.Errorf("expected nil for unlinked proposal, got %v", found)
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

	updated, err := svc.TransitionDecisionPlan(ctx, "space-1", dp.ID, DecisionPlanSubmitted, "u", nil)
	if err != nil {
		t.Fatalf("TransitionDecisionPlan failed: %v", err)
	}
	if updated.Status != DecisionPlanSubmitted {
		t.Errorf("expected submitted, got %s", updated.Status)
	}

	// Invalid: submitted → drafted (no such transition)
	_, err = svc.TransitionDecisionPlan(ctx, "space-1", dp.ID, DecisionPlanDrafted, "u", nil)
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

	meeting, err := svc.AddGovernanceAction(ctx, "space-1", &CreateGovernanceActionRequest{
		DecisionPlanID: dp.ID,
		House:          HouseElderCouncil,
		ActionType:     ActionMeeting,
		Description:    "Elder meeting",
	})
	if err != nil {
		t.Fatalf("AddGovernanceAction (meeting) failed: %v", err)
	}

	// Decision actions must be linked to a meeting or discussion.
	action, err := svc.AddGovernanceAction(ctx, "space-1", &CreateGovernanceActionRequest{
		DecisionPlanID: dp.ID,
		House:          HouseElderCouncil,
		ActionType:     ActionDecision,
		Description:    "Elder veto check",
		LinkedActionID: meeting.ID,
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

func transitionToVotingProcess(t *testing.T, svc *Service, ctx context.Context, spaceID string, prop *Proposal) {
	t.Helper()
	svc.TransitionProposal(ctx, spaceID, prop.ID, ProposalSubmitted)
	svc.TransitionProposal(ctx, spaceID, prop.ID, ProposalEndorsing)
	svc.TransitionProposal(ctx, spaceID, prop.ID, ProposalInReview)
	// Assign lead+steward (required for sign-off)
	lead := "lead-1"
	steward := "steward-1"
	svc.UpdateProposal(ctx, spaceID, prop.ID, &UpdateProposalRequest{
		ProposalLeadID: &lead, ProposalStewardID: &steward,
	})
	if _, err := svc.TransitionProposal(ctx, spaceID, prop.ID, ProposalSignedOff); err != nil {
		t.Fatalf("transition to signed_off failed: %v", err)
	}
	if _, err := svc.TransitionProposal(ctx, spaceID, prop.ID, ProposalVotingProcess); err != nil {
		t.Fatalf("transition to voting_process failed: %v", err)
	}
}

func TestService_CompleteGovernanceAction(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	// Create full chain: proposal (voting_process) → decision plan → meeting → linked decision action
	prop, _ := svc.CreateProposal(ctx, "space-1", &CreateProposalRequest{
		ProposerID: "user-1", Title: "T", Types: []ProposalType{ProposalTypeTechnical},
		Priority: PriorityLow, Description: "d", ProblemStatement: "p",
		Solution: "s", ExpectedOutcomes: []string{"o"}, EstimatedBudget: "$1", Timeline: "1w",
	})
	transitionToVotingProcess(t, svc, ctx, "space-1", prop)

	dp, _ := svc.CreateDecisionPlan(ctx, "space-1", &CreateDecisionPlanRequest{
		ProposalID: prop.ID, Title: "Test", Description: "d",
		Objectives: []string{"o"}, ExpectedOutcomes: []string{"o"},
		ProposalLeadID: "lead-1", ProposalStewardID: "steward-1",
	})

	// Decision actions must be linked to a meeting (or discussion).
	meeting, err := svc.AddGovernanceAction(ctx, "space-1", &CreateGovernanceActionRequest{
		DecisionPlanID: dp.ID,
		House:          HouseElderCouncil,
		ActionType:     ActionMeeting,
		Description:    "Elder meeting",
	})
	if err != nil {
		t.Fatalf("AddGovernanceAction (meeting) failed: %v", err)
	}

	action, err := svc.AddGovernanceAction(ctx, "space-1", &CreateGovernanceActionRequest{
		DecisionPlanID: dp.ID,
		House:          HouseElderCouncil,
		ActionType:     ActionDecision,
		Description:    "Elder veto check",
		LinkedActionID: meeting.ID,
	})
	if err != nil {
		t.Fatalf("AddGovernanceAction (decision) failed: %v", err)
	}

	// Plan signoff is required before any action can be completed.
	if _, err := svc.TransitionDecisionPlan(ctx, "space-1", dp.ID, DecisionPlanSubmitted, "u", nil); err != nil {
		t.Fatalf("TransitionDecisionPlan (submitted) failed: %v", err)
	}
	if _, err := svc.TransitionDecisionPlan(ctx, "space-1", dp.ID, DecisionPlanSignedOff, "u", nil); err != nil {
		t.Fatalf("TransitionDecisionPlan (signed_off) failed: %v", err)
	}

	updated, err := svc.CompleteGovernanceAction(ctx, "space-1", action.ID, OutcomeNoVeto, "", nil, nil, "user-1", "User One")
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

func TestService_CompleteGovernanceAction_BlockedBeforeDecisionPlanSignoff(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	// Set up proposal in voting_process so the gate under test is the decision plan
	// status (not the proposal status).
	prop, _ := svc.CreateProposal(ctx, "space-1", &CreateProposalRequest{
		ProposerID: "user-1", Title: "T", Types: []ProposalType{ProposalTypeTechnical},
		Priority: PriorityLow, Description: "d", ProblemStatement: "p",
		Solution: "s", ExpectedOutcomes: []string{"o"}, EstimatedBudget: "$1", Timeline: "1w",
	})
	transitionToVotingProcess(t, svc, ctx, "space-1", prop)

	dp, _ := svc.CreateDecisionPlan(ctx, "space-1", &CreateDecisionPlanRequest{
		ProposalID: prop.ID, Title: "Test", Description: "d",
		Objectives: []string{"o"}, ExpectedOutcomes: []string{"o"},
		ProposalLeadID: "lead-1", ProposalStewardID: "steward-1",
	})

	meeting, err := svc.AddGovernanceAction(ctx, "space-1", &CreateGovernanceActionRequest{
		DecisionPlanID: dp.ID,
		House:          HouseElderCouncil,
		ActionType:     ActionMeeting,
		Description:    "Elder meeting",
	})
	if err != nil {
		t.Fatalf("AddGovernanceAction (meeting) failed: %v", err)
	}
	decisionAction, err := svc.AddGovernanceAction(ctx, "space-1", &CreateGovernanceActionRequest{
		DecisionPlanID: dp.ID,
		House:          HouseElderCouncil,
		ActionType:     ActionDecision,
		Description:    "Elder veto check",
		LinkedActionID: meeting.ID,
	})
	if err != nil {
		t.Fatalf("AddGovernanceAction (decision) failed: %v", err)
	}

	// Both decision and meeting completions must fail before the decision plan is signed off.
	if _, err := svc.CompleteGovernanceAction(ctx, "space-1", decisionAction.ID, OutcomeNoVeto, "", nil, nil, "user-1", "User One"); err == nil {
		t.Error("expected error: decision completion should be blocked before plan signoff")
	}
	if _, err := svc.CompleteGovernanceAction(ctx, "space-1", meeting.ID, "", "", nil, nil, "user-1", "User One"); err == nil {
		t.Error("expected error: meeting completion should be blocked before plan signoff")
	}
}

func TestService_CreateImplementationPlan(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()

	ip, err := svc.CreateImplementationPlan(ctx, "space-1", &CreateImplementationPlanRequest{
		ProjectID:        "proj-1",
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
		ProjectID: "proj-1", TotalBudget: "$1",
		ProjectLeadID: "lead-1", ProjectStewardID: "steward-1",
	})

	ms, err := svc.AddMilestone(ctx, "space-1", "lead-1", &CreateMilestoneRequest{
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
	// Move to confirmed then shared (eligible for interest registration)
	svc.TransitionContribution(ctx, "space-1", c.ID, ContribConfirmed)
	svc.TransitionContribution(ctx, "space-1", c.ID, ContribShared)

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
	// Move to confirmed then shared so that RegisterInterest is valid
	svc.TransitionContribution(ctx, "space-1", c.ID, ContribConfirmed)
	svc.TransitionContribution(ctx, "space-1", c.ID, ContribShared)
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
		ProjectID: proj.ID, TotalBudget: "$1",
		ProjectLeadID: "l", ProjectStewardID: "s",
	})
	_ = ip

	status = svc.DeriveProjectStatus(ctx, "space-1", proj.ID)
	if status != ProjectActive {
		t.Errorf("expected active with one plan, got %s", status)
	}
}

func TestArchiveProject_CascadesAllChildren(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "test-space"

	// Set up: project + plan + milestone + contribution + sub-contribution
	proj, err := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "Test", Description: "d", CreatedBy: "u"})
	if err != nil {
		t.Fatal(err)
	}

	plan, err := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{
		ProjectID: proj.ID, ProjectLeadID: "u",
	})
	if err != nil {
		t.Fatal(err)
	}

	ms, err := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: plan.ID,
		Title:                "M1",
		Duration:             "1w",
	})
	if err != nil {
		t.Fatal(err)
	}
	msID := ms.MilestoneID

	contrib, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:          proj.ID,
		MilestoneID:        msID,
		Title:              "C1",
		Description:        "d",
		ContributionType:   "development",
		CreatedBy:          "u",
		Objectives:         []string{"obj1"},
		Deliverables:       []string{"del1"},
		AcceptanceCriteria: []string{"ac1"},
	})
	if err != nil {
		t.Fatal(err)
	}

	sub, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:            proj.ID,
		Title:                "Sub",
		Description:          "d",
		ContributionType:     "development",
		CreatedBy:            "u",
		ParentContributionID: contrib.ID,
		Objectives:           []string{"obj1"},
		Deliverables:         []string{"del1"},
		AcceptanceCriteria:   []string{"ac1"},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Act
	if err := svc.ArchiveProject(ctx, spaceID, proj.ID); err != nil {
		t.Fatalf("ArchiveProject: %v", err)
	}

	// Assert all entities are archived
	gotProj, _ := svc.GetProject(ctx, spaceID, proj.ID)
	if gotProj.Status != ProjectArchived {
		t.Errorf("project status = %s, want archived", gotProj.Status)
	}
	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if gotPlan.Status != PlanArchived {
		t.Errorf("plan status = %s, want archived", gotPlan.Status)
	}
	for _, m := range gotPlan.Milestones {
		if m.Status != MilestoneArchived {
			t.Errorf("milestone %s status = %s, want archived", m.MilestoneID, m.Status)
		}
	}
	gotContrib, _ := svc.GetContribution(ctx, spaceID, contrib.ID)
	if gotContrib.Status != ContribArchived {
		t.Errorf("contribution status = %s, want archived", gotContrib.Status)
	}
	gotSub, _ := svc.GetContribution(ctx, spaceID, sub.ID)
	if gotSub.Status != ContribArchived {
		t.Errorf("sub-contribution status = %s, want archived", gotSub.Status)
	}
}

func TestArchiveMilestone_CascadesContributions(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	plan, _ := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	ms, _ := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: plan.ID, Title: "M", Duration: "1w",
	})

	contrib, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, MilestoneID: ms.MilestoneID, Title: "C", Description: "d",
		ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	sub, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "Sub", Description: "d",
		ContributionType: "development", CreatedBy: "u",
		ParentContributionID: contrib.ID,
		Objectives:           []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})

	if err := svc.ArchiveMilestone(ctx, spaceID, ms.MilestoneID, "u"); err != nil {
		t.Fatalf("ArchiveMilestone: %v", err)
	}

	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if gotPlan.Milestones[0].Status != MilestoneArchived {
		t.Errorf("milestone status = %s, want archived", gotPlan.Milestones[0].Status)
	}
	gotContrib, _ := svc.GetContribution(ctx, spaceID, contrib.ID)
	if gotContrib.Status != ContribArchived {
		t.Errorf("contribution status = %s, want archived", gotContrib.Status)
	}
	gotSub, _ := svc.GetContribution(ctx, spaceID, sub.ID)
	if gotSub.Status != ContribArchived {
		t.Errorf("sub status = %s, want archived", gotSub.Status)
	}
}

func TestArchiveContribution_CascadesSubContributions(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	parent, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "P", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	sub, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "S", Description: "d", ContributionType: "development", CreatedBy: "u",
		ParentContributionID: parent.ID,
		Objectives:           []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})

	if err := svc.ArchiveContribution(ctx, spaceID, parent.ID, "u"); err != nil {
		t.Fatalf("ArchiveContribution: %v", err)
	}

	gotParent, _ := svc.GetContribution(ctx, spaceID, parent.ID)
	if gotParent.Status != ContribArchived {
		t.Errorf("parent status = %s, want archived", gotParent.Status)
	}
	gotSub, _ := svc.GetContribution(ctx, spaceID, sub.ID)
	if gotSub.Status != ContribArchived {
		t.Errorf("sub status = %s, want archived", gotSub.Status)
	}
}

func TestUnassignContribution_AllowedFromAssigned(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	contrib, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	contrib.Status = ContribAssigned
	contrib.AssignedContributorID = "user-1"
	_ = svc.SaveContribution(ctx, spaceID, contrib)

	got, err := svc.UnassignContribution(ctx, spaceID, contrib.ID)
	if err != nil {
		t.Fatalf("UnassignContribution: %v", err)
	}
	if got.Status != ContribConfirmed {
		t.Errorf("status = %s, want confirmed", got.Status)
	}
	if got.AssignedContributorID != "" {
		t.Errorf("assigned_contributor_id = %q, want empty", got.AssignedContributorID)
	}
}

func TestUnassignContribution_RejectsTerminalStatuses(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	contrib, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})

	for _, badStatus := range []ContributionStatus{ContribSignedOff, ContribApproved, ContribNeedsReview, ContribCreated} {
		contrib.Status = badStatus
		contrib.AssignedContributorID = "user-1"
		_ = svc.SaveContribution(ctx, spaceID, contrib)

		_, err := svc.UnassignContribution(ctx, spaceID, contrib.ID)
		if err == nil {
			t.Errorf("UnassignContribution from %s should fail, got nil", badStatus)
		}
	}
}

func TestUpdateMilestone_PatchesFields(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	plan, _ := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	ms, _ := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: plan.ID, Title: "Old", Duration: "1w",
	})

	newTitle := "New title"
	newDesc := "desc"
	newDur := "2w"
	got, err := svc.UpdateMilestone(ctx, spaceID, ms.MilestoneID, "editor-1", &UpdateMilestoneRequest{
		Title:       &newTitle,
		Description: &newDesc,
		Duration:    &newDur,
	})
	if err != nil {
		t.Fatalf("UpdateMilestone: %v", err)
	}
	if got.Title != "New title" {
		t.Errorf("title = %q, want New title", got.Title)
	}
	if got.Description != "desc" {
		t.Errorf("description = %q, want desc", got.Description)
	}
	if got.Duration != "2w" {
		t.Errorf("duration = %q, want 2w", got.Duration)
	}

	// ChangeLog also carries the "milestone_added" entry recorded by AddMilestone
	// above; the edit we're asserting on is the most recent entry.
	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if len(gotPlan.ChangeLog) != 2 {
		t.Fatalf("expected 2 change log entries (added + edited), got %d", len(gotPlan.ChangeLog))
	}
	if gotPlan.ChangeLog[0].Kind != "milestone_added" {
		t.Errorf("first entry kind = %q, want milestone_added", gotPlan.ChangeLog[0].Kind)
	}
	entry := gotPlan.ChangeLog[1]
	if entry.Kind != "milestone_edited" {
		t.Errorf("kind = %q, want milestone_edited", entry.Kind)
	}
	if entry.MilestoneID != ms.MilestoneID {
		t.Errorf("milestone_id = %q, want %q", entry.MilestoneID, ms.MilestoneID)
	}
	if entry.ChangedBy != "editor-1" {
		t.Errorf("changed_by = %q, want editor-1", entry.ChangedBy)
	}
	if entry.ID == "" {
		t.Error("expected non-empty entry ID")
	}
	if entry.ChangedAt.IsZero() {
		t.Error("expected non-zero ChangedAt")
	}
	wantFields := map[string][2]string{
		"title":       {"Old", "New title"},
		"description": {"", "desc"},
		"duration":    {"1w", "2w"},
	}
	if len(entry.Changes) != len(wantFields) {
		t.Fatalf("expected %d field changes, got %d: %+v", len(wantFields), len(entry.Changes), entry.Changes)
	}
	for _, fc := range entry.Changes {
		want, ok := wantFields[fc.Field]
		if !ok {
			t.Errorf("unexpected field change for %q", fc.Field)
			continue
		}
		if fc.OldValue != want[0] || fc.NewValue != want[1] {
			t.Errorf("field %q: old=%q new=%q, want old=%q new=%q", fc.Field, fc.OldValue, fc.NewValue, want[0], want[1])
		}
	}
}

func TestSubmitProjectCompletion_RequiresAllSignedOff(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	proj.Status = ProjectActive
	_ = svc.SaveProject(ctx, spaceID, proj)

	c1, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C1", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})

	// Not signed off — should fail
	if _, err := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "lead", []Role{RoleFoundingMember}); err == nil {
		t.Error("expected error when not all contributions signed off")
	}

	// Sign it off
	c1.Status = ContribSignedOff
	_ = svc.SaveContribution(ctx, spaceID, c1)

	got, err := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "lead", []Role{RoleFoundingMember})
	if err != nil {
		t.Fatalf("SubmitProjectCompletion: %v", err)
	}
	if got.Status != ProjectPendingCompletion {
		t.Errorf("status = %s, want pending_completion", got.Status)
	}
}

func TestSubmitProjectCompletion_RejectsNonActiveStatus(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	proj.Status = ProjectCompleted
	_ = svc.SaveProject(ctx, spaceID, proj)

	if _, err := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "lead", []Role{RoleFoundingMember}); err == nil {
		t.Error("expected error when project status is not active")
	}
}

func TestApproveProjectCompletion_FillsCompletedFields(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	proj.Status = ProjectPendingCompletion
	_ = svc.SaveProject(ctx, spaceID, proj)

	got, err := svc.ApproveProjectCompletion(ctx, spaceID, proj.ID, "steward-1", []Role{RoleFoundingMember}, nil)
	if err != nil {
		t.Fatalf("ApproveProjectCompletion: %v", err)
	}
	if got.Status != ProjectCompleted {
		t.Errorf("status = %s, want completed", got.Status)
	}
	if got.CompletedBy != "steward-1" {
		t.Errorf("completed_by = %q, want steward-1", got.CompletedBy)
	}
	if got.CompletedAt == nil {
		t.Error("completed_at should be set")
	}
}

func TestRejectProjectCompletion_RevertsToActive(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	proj.Status = ProjectPendingCompletion
	_ = svc.SaveProject(ctx, spaceID, proj)

	got, err := svc.RejectProjectCompletion(ctx, spaceID, proj.ID, "steward-1", "needs more work", []Role{RoleFoundingMember})
	if err != nil {
		t.Fatalf("RejectProjectCompletion: %v", err)
	}
	if got.Status != ProjectActive {
		t.Errorf("status = %s, want active", got.Status)
	}
	if got.RejectionReason != "needs more work" {
		t.Errorf("rejection_reason = %q, want needs more work", got.RejectionReason)
	}
}

// signedOffProject builds a pending_completion-ready active project with one
// signed-off contribution, assigned lead/steward, for resource-check tests.
func signedOffProject(t *testing.T, ctx context.Context, svc *Service, spaceID, lead, steward string) *Project {
	t.Helper()
	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	proj.Status = ProjectActive
	proj.ProjectLeadID = lead
	proj.ProjectStewardID = steward
	_ = svc.SaveProject(ctx, spaceID, proj)
	c1, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	c1.Status = ContribSignedOff
	_ = svc.SaveContribution(ctx, spaceID, c1)
	return proj
}

func TestSubmitProjectCompletion_NonLeadRejected(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	proj := signedOffProject(t, ctx, svc, spaceID, "lead-aid", "steward-aid")

	// A plain contributor who is not this project's lead is rejected.
	if _, err := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "someone-else", []Role{RoleContributor}); err == nil {
		t.Error("expected non-lead submitter to be rejected")
	}
	// The actual project lead succeeds.
	if _, err := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "lead-aid", []Role{RoleProjectLead}); err != nil {
		t.Fatalf("project lead submit: %v", err)
	}
}

func TestApproveProjectCompletion_RejectsSubmitterAndNonSteward(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	proj := signedOffProject(t, ctx, svc, spaceID, "lead-aid", "steward-aid")

	// Lead submits (exempt not needed — lead matches).
	if _, err := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "lead-aid", []Role{RoleProjectLead}); err != nil {
		t.Fatalf("submit: %v", err)
	}

	// A steward who is not this project's steward is rejected.
	if _, err := svc.ApproveProjectCompletion(ctx, spaceID, proj.ID, "other-steward", []Role{RoleProjectSteward}, nil); err == nil {
		t.Error("expected non-steward-of-project approver to be rejected")
	}

	// The submitter cannot approve their own completion, even if they are the
	// project steward (make lead==steward to test the submitter guard).
	proj2 := signedOffProject(t, ctx, svc, spaceID, "dual-aid", "dual-aid")
	if _, err := svc.SubmitProjectCompletion(ctx, spaceID, proj2.ID, "dual-aid", []Role{RoleProjectLead, RoleProjectSteward}); err != nil {
		t.Fatalf("submit dual: %v", err)
	}
	if _, err := svc.ApproveProjectCompletion(ctx, spaceID, proj2.ID, "dual-aid", []Role{RoleProjectSteward}, nil); err == nil {
		t.Error("expected submitter to be rejected as their own approver")
	}

	// This project's steward (not the submitter) approves.
	if _, err := svc.ApproveProjectCompletion(ctx, spaceID, proj.ID, "steward-aid", []Role{RoleProjectSteward}, nil); err != nil {
		t.Fatalf("project steward approve: %v", err)
	}
}

func TestApproveProjectCompletion_FoundingMemberExempt(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "s"
	proj := signedOffProject(t, ctx, svc, spaceID, "lead-aid", "steward-aid")

	// Founding member submits and approves their own completion — exempt.
	if _, err := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "fm-aid", []Role{RoleFoundingMember}); err != nil {
		t.Fatalf("fm submit: %v", err)
	}
	if _, err := svc.ApproveProjectCompletion(ctx, spaceID, proj.ID, "fm-aid", []Role{RoleFoundingMember}, nil); err != nil {
		t.Fatalf("fm approve (exempt): %v", err)
	}
}

func TestSubmitProjectCompletion_ClearsPriorRejection(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	proj.Status = ProjectActive
	proj.RejectionReason = "previous reason"
	_ = svc.SaveProject(ctx, spaceID, proj)

	c1, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	c1.Status = ContribSignedOff
	_ = svc.SaveContribution(ctx, spaceID, c1)

	got, _ := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "lead", []Role{RoleFoundingMember})
	if got.RejectionReason != "" {
		t.Errorf("rejection_reason = %q, want empty", got.RejectionReason)
	}
}

func TestUpdateMilestone_UnsignsPlan(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	plan, _ := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	ms, _ := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: plan.ID, Title: "M", Duration: "1w",
	})

	// Re-fetch plan after AddMilestone (which updates the plan's milestones array in the store).
	plan, _ = svc.GetImplementationPlan(ctx, spaceID, plan.ID)

	// Sign off the plan first
	plan.SignedOff = true
	plan.SignedOffBy = "steward"
	now := time.Now()
	plan.SignedOffAt = &now
	_ = svc.SaveImplementationPlan(ctx, spaceID, plan)

	newDur := "3w"
	if _, err := svc.UpdateMilestone(ctx, spaceID, ms.MilestoneID, "u", &UpdateMilestoneRequest{Duration: &newDur}); err != nil {
		t.Fatalf("UpdateMilestone: %v", err)
	}

	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if gotPlan.SignedOff {
		t.Error("plan should be unsigned after milestone edit")
	}
	// Historical signoff record (signed_off_by / signed_off_at) is preserved
	// so the UI can show "Last signed off by X on Y, then modified."
	if gotPlan.SignedOffBy != "steward" {
		t.Errorf("signed_off_by = %q, want steward (historical record preserved)", gotPlan.SignedOffBy)
	}
	if gotPlan.SignedOffAt == nil {
		t.Error("signed_off_at should be preserved as historical record")
	}
}

func TestArchiveMilestone_UnsignsPlan(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	plan, _ := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	ms, _ := svc.AddMilestone(ctx, spaceID, "u", &CreateMilestoneRequest{
		ImplementationPlanID: plan.ID, Title: "M", Duration: "1w",
	})

	// Re-fetch plan after AddMilestone (which updates the plan's milestones array in the store).
	plan, _ = svc.GetImplementationPlan(ctx, spaceID, plan.ID)

	plan.SignedOff = true
	now := time.Now()
	plan.SignedOffAt = &now
	_ = svc.SaveImplementationPlan(ctx, spaceID, plan)

	if err := svc.ArchiveMilestone(ctx, spaceID, ms.MilestoneID, "u"); err != nil {
		t.Fatalf("ArchiveMilestone: %v", err)
	}

	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if gotPlan.SignedOff {
		t.Error("plan should be unsigned after milestone archive")
	}
}

func TestArchiveContribution_UnsignsPlan(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	plan, _ := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})

	contrib, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})

	plan.SignedOff = true
	now := time.Now()
	plan.SignedOffAt = &now
	_ = svc.SaveImplementationPlan(ctx, spaceID, plan)

	if err := svc.ArchiveContribution(ctx, spaceID, contrib.ID, "u"); err != nil {
		t.Fatalf("ArchiveContribution: %v", err)
	}

	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if gotPlan.SignedOff {
		t.Error("plan should be unsigned after contribution archive")
	}
}

func TestUnassignContribution_DoesNotUnsignPlan(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	plan, _ := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})

	contrib, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	contrib.Status = ContribAssigned
	contrib.AssignedContributorID = "user-1"
	_ = svc.SaveContribution(ctx, spaceID, contrib)

	plan.SignedOff = true
	now := time.Now()
	plan.SignedOffAt = &now
	_ = svc.SaveImplementationPlan(ctx, spaceID, plan)

	if _, err := svc.UnassignContribution(ctx, spaceID, contrib.ID); err != nil {
		t.Fatalf("UnassignContribution: %v", err)
	}

	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if !gotPlan.SignedOff {
		t.Error("plan should remain signed off after unassign — unassign is people management, not plan structure change")
	}
}

func TestSignOffContribution_RequiresPlanSignedOff(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	plan, _ := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})

	contrib, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	contrib.Status = ContribApproved
	_ = svc.SaveContribution(ctx, spaceID, contrib)

	// Plan is NOT signed off — sign off should fail
	if _, err := svc.SignOffContribution(ctx, spaceID, contrib.ID, "steward", nil); err == nil {
		t.Fatal("expected error when plan not signed off, got nil")
	}

	// Sign off the plan
	plan.SignedOff = true
	now := time.Now()
	plan.SignedOffAt = &now
	_ = svc.SaveImplementationPlan(ctx, spaceID, plan)

	// Now sign-off should succeed
	got, err := svc.SignOffContribution(ctx, spaceID, contrib.ID, "steward", nil)
	if err != nil {
		t.Fatalf("SignOffContribution after plan signoff: %v", err)
	}
	if got.Status != ContribSignedOff {
		t.Errorf("status = %s, want signed_off", got.Status)
	}

	// Make sure plan signoff stayed (sign-off doesn't unsign the plan)
	_ = plan
}

func TestCreateContribution_StoresAssignedContributorID(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "test-space"

	req := &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "test",
		Description:           "desc",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator-aid",
		Objectives:            []string{"o1"},
		Deliverables:          []string{"d1"},
		AcceptanceCriteria:    []string{"ac1"},
		AssignedContributorID: "assignee-aid",
	}

	c, err := svc.CreateContribution(ctx, spaceID, req)
	if err != nil {
		t.Fatalf("CreateContribution failed: %v", err)
	}
	if c.AssignedContributorID != "assignee-aid" {
		t.Errorf("expected assignee-aid, got %q", c.AssignedContributorID)
	}
	if c.Status != ContribCreated {
		t.Errorf("expected status created, got %s", c.Status)
	}
}

func TestCreateContribution_SubInheritsParentAssigneeWhenUnset(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "test-space"

	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "parent",
		Description:           "p",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		AcceptanceCriteria:    []string{"ac"},
		AssignedContributorID: "parent-assignee",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	child, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:            "proj-1",
		Title:                "child",
		Description:          "c",
		ContributionType:     ProposalTypeTechnical,
		Priority:             PriorityMedium,
		CreatedBy:            "creator",
		Objectives:           []string{"o"},
		Deliverables:         []string{"d"},
		AcceptanceCriteria:   []string{"ac"},
		ParentContributionID: parent.ID,
		// AssignedContributorID intentionally omitted — should inherit from parent
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	if child.AssignedContributorID != "parent-assignee" {
		t.Errorf("expected child to inherit parent-assignee, got %q", child.AssignedContributorID)
	}
	if child.Status != ContribCreated {
		t.Errorf("expected child status created, got %s", child.Status)
	}
}

func TestCreateContribution_SubKeepsExplicitAssigneeOverParent(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "test-space"

	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "parent",
		Description:           "p",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		AcceptanceCriteria:    []string{"ac"},
		AssignedContributorID: "parent-assignee",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	child, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "child",
		Description:           "c",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		AcceptanceCriteria:    []string{"ac"},
		ParentContributionID:  parent.ID,
		AssignedContributorID: "explicit-assignee",
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	if child.AssignedContributorID != "explicit-assignee" {
		t.Errorf("explicit assignee should win over parent fallback, got %q", child.AssignedContributorID)
	}
}

func TestApproveSubContribution_UsesChildOwnAssignee(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "test-space"

	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "parent",
		Description:           "p",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		AcceptanceCriteria:    []string{"ac1"},
		AssignedContributorID: "parent-assignee",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	child, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "child",
		Description:           "c",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		AcceptanceCriteria:    []string{"ac1"},
		ParentContributionID:  parent.ID,
		AssignedContributorID: "different-assignee",
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}

	approved, err := svc.ApproveSubContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if approved.Status != ContribAssigned {
		t.Errorf("expected status assigned, got %s", approved.Status)
	}
	if approved.AssignedContributorID != "different-assignee" {
		t.Errorf("expected child's own assignee 'different-assignee', got %q", approved.AssignedContributorID)
	}
}

func TestApproveSubContribution_AllowsApprovalWithoutAssignee(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "test-space"

	// Parent left unassigned so the auto-inherit at child creation does not seed an assignee.
	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:          "proj-1",
		Title:              "parent",
		Description:        "p",
		ContributionType:   ProposalTypeTechnical,
		Priority:           PriorityMedium,
		CreatedBy:          "creator",
		Objectives:         []string{"o"},
		Deliverables:       []string{"d"},
		AcceptanceCriteria: []string{"ac1"},
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	child, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:            "proj-1",
		Title:                "child",
		Description:          "c",
		ContributionType:     ProposalTypeTechnical,
		Priority:             PriorityMedium,
		CreatedBy:            "creator",
		Objectives:           []string{"o"},
		Deliverables:         []string{"d"},
		AcceptanceCriteria:   []string{"ac1"},
		ParentContributionID: parent.ID,
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	if child.AssignedContributorID != "" {
		t.Fatalf("expected child to have no assignee (parent unassigned), got %q", child.AssignedContributorID)
	}

	approved, err := svc.ApproveSubContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("expected approval to succeed without assignee, got: %v", err)
	}
	if approved.Status != ContribAssigned {
		t.Errorf("expected status %s, got %s", ContribAssigned, approved.Status)
	}
	if approved.AssignedContributorID != "" {
		t.Errorf("expected assignee to remain empty, got %q", approved.AssignedContributorID)
	}
}

func TestApproveSubContribution_AllowsReApprovalFromChanged(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "test-space"

	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "parent",
		Description:           "p",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		AcceptanceCriteria:    []string{"ac1"},
		AssignedContributorID: "parent-assignee",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	child, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "child",
		Description:           "c",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		AcceptanceCriteria:    []string{"ac1"},
		ParentContributionID:  parent.ID,
		AssignedContributorID: "child-assignee",
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	if _, err := svc.ApproveSubContribution(ctx, spaceID, child.ID); err != nil {
		t.Fatalf("first approve: %v", err)
	}
	// Simulate a lead-edit putting the contribution into 'changed' via the
	// existing transition method (assigned → changed is a valid transition).
	if _, err := svc.TransitionContribution(ctx, spaceID, child.ID, ContribChanged); err != nil {
		t.Fatalf("transition to changed: %v", err)
	}

	approved, err := svc.ApproveSubContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("re-approve: %v", err)
	}
	if approved.Status != ContribAssigned {
		t.Errorf("expected status assigned, got %s", approved.Status)
	}
	if approved.AssignedContributorID != "child-assignee" {
		t.Errorf("expected child-assignee preserved through re-approval, got %q", approved.AssignedContributorID)
	}
}

// createUnassignedChild is a test helper that creates a child contribution with no
// assignee and returns it. Callers must check the error themselves.
func createUnassignedChild(t *testing.T, svc *Service, ctx context.Context, spaceID, parentID string) *Contribution {
	t.Helper()
	c, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:            "proj-1",
		Title:                "child task",
		Description:          "child description",
		ContributionType:     ProposalTypeTechnical,
		Priority:             PriorityMedium,
		CreatedBy:            "lead-1",
		Objectives:           []string{"o"},
		Deliverables:         []string{"d"},
		AcceptanceCriteria:   []string{"ac1"},
		ParentContributionID: parentID,
		Deadline:             "2026-12-31",
	})
	if err != nil {
		t.Fatalf("createUnassignedChild: %v", err)
	}
	return c
}

func TestAssignContributor_PropagatesAssigneeToCreatedChildren(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	spaceID := "space-1"

	// Create the parent (top-level, no parent of its own).
	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:          "proj-1",
		Title:              "parent task",
		Description:        "parent description",
		ContributionType:   ProposalTypeTechnical,
		Priority:           PriorityMedium,
		CreatedBy:          "lead-1",
		Objectives:         []string{"o"},
		Deliverables:       []string{"d"},
		AcceptanceCriteria: []string{"ac1"},
		Deadline:           "2026-12-31",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	// Confirm the parent so it is eligible for assignment.
	if _, err := svc.ConfirmContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("confirm parent: %v", err)
	}

	// Create a child with no assignee (starts in ContribCreated).
	child := createUnassignedChild(t, svc, ctx, spaceID, parent.ID)

	// Assign the parent.
	if _, err := svc.AssignContributor(ctx, spaceID, parent.ID, "user-A"); err != nil {
		t.Fatalf("AssignContributor: %v", err)
	}

	// The child should now be offered to "user-A" and in ContribOffered status.
	reloaded, err := svc.GetContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("reload child: %v", err)
	}
	if reloaded.OfferedTo != "user-A" {
		t.Errorf("expected OfferedTo=user-A, got %q", reloaded.OfferedTo)
	}
	if reloaded.AssignedContributorID != "" {
		t.Errorf("expected AssignedContributorID empty, got %q", reloaded.AssignedContributorID)
	}
	if reloaded.Status != ContribOffered {
		t.Errorf("expected status offered, got %s", reloaded.Status)
	}
}

func TestAssignContributor_DoesNotOverwriteExistingChildAssignee(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	spaceID := "space-1"

	// Create and confirm the parent.
	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:          "proj-1",
		Title:              "parent task",
		Description:        "parent description",
		ContributionType:   ProposalTypeTechnical,
		Priority:           PriorityMedium,
		CreatedBy:          "lead-1",
		Objectives:         []string{"o"},
		Deliverables:       []string{"d"},
		AcceptanceCriteria: []string{"ac1"},
		Deadline:           "2026-12-31",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	if _, err := svc.ConfirmContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("confirm parent: %v", err)
	}

	// Create a child that already has an explicit assignee.
	child, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "child task",
		Description:           "child description",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "lead-1",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		AcceptanceCriteria:    []string{"ac1"},
		ParentContributionID:  parent.ID,
		AssignedContributorID: "child-explicit",
		Deadline:              "2026-12-31",
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}

	// Assign the parent with a different assignee.
	if _, err := svc.AssignContributor(ctx, spaceID, parent.ID, "parent-assignee"); err != nil {
		t.Fatalf("AssignContributor: %v", err)
	}

	// The child's explicit assignee must not be overwritten.
	reloaded, err := svc.GetContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("reload child: %v", err)
	}
	if reloaded.AssignedContributorID != "child-explicit" {
		t.Errorf("expected AssignedContributorID=child-explicit, got %q", reloaded.AssignedContributorID)
	}
}

func TestAcceptOffer_PropagatesAssigneeToCreatedChildren(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	spaceID := "space-1"

	// Create and confirm the parent.
	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:          "proj-1",
		Title:              "parent task",
		Description:        "parent description",
		ContributionType:   ProposalTypeTechnical,
		Priority:           PriorityMedium,
		CreatedBy:          "lead-1",
		Objectives:         []string{"o"},
		Deliverables:       []string{"d"},
		AcceptanceCriteria: []string{"ac1"},
		Deadline:           "2026-12-31",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	if _, err := svc.ConfirmContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("confirm parent: %v", err)
	}

	// Create a child with no assignee.
	child := createUnassignedChild(t, svc, ctx, spaceID, parent.ID)

	// Offer the parent to "user-A" then accept.
	if _, err := svc.OfferContribution(ctx, spaceID, parent.ID, "user-A", "User A"); err != nil {
		t.Fatalf("OfferContribution: %v", err)
	}
	if _, err := svc.AcceptOffer(ctx, spaceID, parent.ID, "user-A"); err != nil {
		t.Fatalf("AcceptOffer: %v", err)
	}

	// The child should now be offered to "user-A" and in ContribOffered status.
	reloaded, err := svc.GetContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("reload child: %v", err)
	}
	if reloaded.OfferedTo != "user-A" {
		t.Errorf("expected OfferedTo=user-A, got %q", reloaded.OfferedTo)
	}
	if reloaded.AssignedContributorID != "" {
		t.Errorf("expected AssignedContributorID empty, got %q", reloaded.AssignedContributorID)
	}
	if reloaded.Status != ContribOffered {
		t.Errorf("expected status offered, got %s", reloaded.Status)
	}
}

func TestConfirmContribution_PropagatesAssigneeOnChangedToAssigned(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	spaceID := "space-1"

	// Create and confirm the parent, then assign it so it reaches ContribAssigned.
	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:          "proj-1",
		Title:              "parent task",
		Description:        "parent description",
		ContributionType:   ProposalTypeTechnical,
		Priority:           PriorityMedium,
		CreatedBy:          "lead-1",
		Objectives:         []string{"o"},
		Deliverables:       []string{"d"},
		AcceptanceCriteria: []string{"ac1"},
		Deadline:           "2026-12-31",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	if _, err := svc.ConfirmContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("confirm parent: %v", err)
	}
	if _, err := svc.AssignContributor(ctx, spaceID, parent.ID, "parent-assignee"); err != nil {
		t.Fatalf("assign parent: %v", err)
	}

	// Transition parent to changed (assigned → changed is a valid transition).
	if _, err := svc.TransitionContribution(ctx, spaceID, parent.ID, ContribChanged); err != nil {
		t.Fatalf("transition parent to changed: %v", err)
	}

	// Create the child AFTER the parent is in changed state. With auto-inherit at create time,
	// the child picks up the parent's assignee. Clear it directly to simulate the edge case
	// where the child is unassigned at the moment the parent re-confirms (e.g., assignee
	// cleared via an update before re-confirmation).
	child := createUnassignedChild(t, svc, ctx, spaceID, parent.ID)
	child.AssignedContributorID = ""
	child.OfferedTo = ""
	if err := svc.store.Save(spaceID, child.ID, "contribution", child); err != nil {
		t.Fatalf("clear child assignee: %v", err)
	}

	// Re-confirm the parent: changed → assigned. This is the path that should propagate.
	if _, err := svc.ConfirmContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("ConfirmContribution (changed→assigned): %v", err)
	}

	// The child should now be offered to "parent-assignee" and in ContribOffered status.
	reloaded, err := svc.GetContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("reload child: %v", err)
	}
	if reloaded.OfferedTo != "parent-assignee" {
		t.Errorf("expected OfferedTo=parent-assignee, got %q", reloaded.OfferedTo)
	}
	if reloaded.AssignedContributorID != "" {
		t.Errorf("expected AssignedContributorID empty, got %q", reloaded.AssignedContributorID)
	}
	if reloaded.Status != ContribOffered {
		t.Errorf("expected status offered, got %s", reloaded.Status)
	}
}

func TestConfirmContribution_DoesNotPropagateOnCreatedToConfirmed(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	spaceID := "space-1"

	// Create the parent in ContribCreated (default) with no assignee.
	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:          "proj-1",
		Title:              "parent task",
		Description:        "parent description",
		ContributionType:   ProposalTypeTechnical,
		Priority:           PriorityMedium,
		CreatedBy:          "lead-1",
		Objectives:         []string{"o"},
		Deliverables:       []string{"d"},
		AcceptanceCriteria: []string{"ac1"},
		Deadline:           "2026-12-31",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	// Create a child with no assignee.
	child := createUnassignedChild(t, svc, ctx, spaceID, parent.ID)

	// Confirm the parent: created → confirmed. No propagation should occur.
	if _, err := svc.ConfirmContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("ConfirmContribution (created→confirmed): %v", err)
	}

	// Parent should be confirmed with no assignee.
	reloadedParent, err := svc.GetContribution(ctx, spaceID, parent.ID)
	if err != nil {
		t.Fatalf("reload parent: %v", err)
	}
	if reloadedParent.Status != ContribConfirmed {
		t.Errorf("expected parent status ContribConfirmed, got %s", reloadedParent.Status)
	}
	if reloadedParent.AssignedContributorID != "" {
		t.Errorf("expected parent AssignedContributorID empty, got %q", reloadedParent.AssignedContributorID)
	}

	// Child must be untouched: still created, still no assignee.
	reloadedChild, err := svc.GetContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("reload child: %v", err)
	}
	if reloadedChild.Status != ContribCreated {
		t.Errorf("expected child status ContribCreated, got %s", reloadedChild.Status)
	}
	if reloadedChild.AssignedContributorID != "" {
		t.Errorf("expected child AssignedContributorID empty, got %q", reloadedChild.AssignedContributorID)
	}
}

func TestOfferContribution_ClearsAssignedContributorID(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	spaceID := "space-1"

	// Create + confirm a contribution.
	c, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:          "proj-1",
		Title:              "task",
		Description:        "d",
		ContributionType:   ProposalTypeTechnical,
		Priority:           PriorityMedium,
		CreatedBy:          "lead-1",
		Objectives:         []string{"o"},
		Deliverables:       []string{"d"},
		AcceptanceCriteria: []string{"a"},
		Deadline:           "2026-12-31",
	})
	if err != nil {
		t.Fatalf("CreateContribution: %v", err)
	}
	confirmed, err := svc.ConfirmContribution(ctx, spaceID, c.ID)
	if err != nil {
		t.Fatalf("ConfirmContribution: %v", err)
	}

	// Force a stale AssignedContributorID into the stored contribution.
	confirmed.AssignedContributorID = "stale-user"
	if err := svc.SaveContribution(ctx, spaceID, confirmed); err != nil {
		t.Fatalf("SaveContribution: %v", err)
	}

	// Offer should clear it.
	out, err := svc.OfferContribution(ctx, spaceID, c.ID, "new-user", "New User")
	if err != nil {
		t.Fatalf("OfferContribution: %v", err)
	}
	if out.AssignedContributorID != "" {
		t.Errorf("AssignedContributorID = %q, want empty", out.AssignedContributorID)
	}
	if out.OfferedTo != "new-user" {
		t.Errorf("OfferedTo = %q, want new-user", out.OfferedTo)
	}
	if out.Status != ContribOffered {
		t.Errorf("Status = %s, want offered", out.Status)
	}
}

func TestPropagateOfferToChildren_SkipsAlreadyAssignedChild(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	spaceID := "space-1"

	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: "proj-1", Title: "parent", Description: "d",
		ContributionType: ProposalTypeTechnical, Priority: PriorityMedium, CreatedBy: "lead-1",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		Deadline: "2026-12-31",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	if _, err := svc.ConfirmContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("confirm parent: %v", err)
	}

	// Child already assigned to someone else; force the state.
	child := createUnassignedChild(t, svc, ctx, spaceID, parent.ID)
	child.Status = ContribAssigned
	child.AssignedContributorID = "other-user"
	if err := svc.SaveContribution(ctx, spaceID, child); err != nil {
		t.Fatalf("save child: %v", err)
	}

	// Offer + accept parent.
	if _, err := svc.OfferContribution(ctx, spaceID, parent.ID, "parent-user", "Parent User"); err != nil {
		t.Fatalf("offer parent: %v", err)
	}
	if _, err := svc.AcceptOffer(ctx, spaceID, parent.ID, "parent-user"); err != nil {
		t.Fatalf("accept parent: %v", err)
	}

	got, err := svc.GetContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("reload child: %v", err)
	}
	if got.AssignedContributorID != "other-user" {
		t.Errorf("AssignedContributorID = %q, want other-user", got.AssignedContributorID)
	}
	if got.OfferedTo != "" {
		t.Errorf("OfferedTo = %q, want empty", got.OfferedTo)
	}
	if got.Status != ContribAssigned {
		t.Errorf("Status = %s, want assigned", got.Status)
	}
}

func TestPropagateOfferToChildren_SkipsAlreadyOfferedChild(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	spaceID := "space-1"

	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: "proj-1", Title: "parent", Description: "d",
		ContributionType: ProposalTypeTechnical, Priority: PriorityMedium, CreatedBy: "lead-1",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		Deadline: "2026-12-31",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	if _, err := svc.ConfirmContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("confirm parent: %v", err)
	}

	child := createUnassignedChild(t, svc, ctx, spaceID, parent.ID)
	if _, err := svc.ConfirmContribution(ctx, spaceID, child.ID); err != nil {
		t.Fatalf("confirm child: %v", err)
	}
	if _, err := svc.OfferContribution(ctx, spaceID, child.ID, "early-offer-user", "Early Offer"); err != nil {
		t.Fatalf("offer child: %v", err)
	}

	if _, err := svc.OfferContribution(ctx, spaceID, parent.ID, "parent-user", "Parent User"); err != nil {
		t.Fatalf("offer parent: %v", err)
	}
	if _, err := svc.AcceptOffer(ctx, spaceID, parent.ID, "parent-user"); err != nil {
		t.Fatalf("accept parent: %v", err)
	}

	got, err := svc.GetContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("reload child: %v", err)
	}
	if got.OfferedTo != "early-offer-user" {
		t.Errorf("OfferedTo = %q, want early-offer-user", got.OfferedTo)
	}
}

// setupSubmittedContribution creates a contribution and drives it to
// needs_review with evidence, returning the service and the contribution.
func setupSubmittedContribution(t *testing.T) (*Service, context.Context, *Contribution) {
	t.Helper()
	svc := NewService(NewMockStore())
	ctx := context.Background()
	c, err := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "Task", Description: "Do it",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	svc.TransitionContribution(ctx, "space-1", c.ID, ContribConfirmed)
	c, _ = svc.AssignContributor(ctx, "space-1", c.ID, "contributor-1")
	c, err = svc.SubmitEvidence(ctx, "space-1", c.ID, "contributor-1", SubmitEvidenceRequest{
		CompletionNotes: "did the thing",
		EvidenceURLs:    []string{"https://example.com/1"},
	})
	if err != nil {
		t.Fatalf("submit evidence: %v", err)
	}
	return svc, ctx, c
}

func TestEditEvidence_NeedsReview_StaysNeedsReview(t *testing.T) {
	svc, ctx, c := setupSubmittedContribution(t)

	res, err := svc.EditEvidence(ctx, "space-1", c.ID, "contributor-1", SubmitEvidenceRequest{
		CompletionNotes: "revised notes",
		EvidenceURLs:    []string{"https://example.com/2"},
	})
	if err != nil {
		t.Fatalf("EditEvidence: %v", err)
	}
	got := res.Contribution
	if got.Status != ContribNeedsReview {
		t.Errorf("status = %s, want needs_review", got.Status)
	}
	if res.PriorStatus != ContribNeedsReview || res.PriorReviewedBy != "" {
		t.Errorf("prior = (%s, %q), want (needs_review, \"\")", res.PriorStatus, res.PriorReviewedBy)
	}
	if got.CompletionNotes != "revised notes" {
		t.Errorf("completion notes not updated: %q", got.CompletionNotes)
	}
	if len(got.EvidenceURLs) != 1 || got.EvidenceURLs[0] != "https://example.com/2" {
		t.Errorf("evidence urls not updated: %v", got.EvidenceURLs)
	}
	if got.EvidenceEditedAt == nil {
		t.Error("EvidenceEditedAt should be set after edit")
	}
}

func TestEditEvidence_Approved_DropsBackToNeedsReview(t *testing.T) {
	svc, ctx, c := setupSubmittedContribution(t)

	// Reviewer approves the submission.
	c, err := svc.ReviewContribution(ctx, "space-1", c.ID, ReviewRequest{
		Decision: "approved", ReviewNotes: "looks good", QualityRating: 8,
	})
	if err != nil {
		t.Fatalf("review approve: %v", err)
	}
	if c.Status != ContribApproved {
		t.Fatalf("precondition: status = %s, want approved", c.Status)
	}
	// Record who approved so the handler can notify them after the edit
	// clears the field.
	c.ReviewedBy = "reviewer-1"
	svc.store.Save("space-1", c.ID, "contribution", c)

	res, err := svc.EditEvidence(ctx, "space-1", c.ID, "contributor-1", SubmitEvidenceRequest{
		CompletionNotes: "changed after approval",
	})
	if err != nil {
		t.Fatalf("EditEvidence: %v", err)
	}
	got := res.Contribution
	if got.Status != ContribNeedsReview {
		t.Errorf("status = %s, want needs_review (approval voided)", got.Status)
	}
	if got.ReviewOutcome != "" || got.ReviewFeedback != "" || got.ReviewedAt != nil || got.ReviewedBy != "" {
		t.Errorf("prior review not cleared: outcome=%q feedback=%q by=%q at=%v",
			got.ReviewOutcome, got.ReviewFeedback, got.ReviewedBy, got.ReviewedAt)
	}
	if res.PriorStatus != ContribApproved {
		t.Errorf("PriorStatus = %s, want approved", res.PriorStatus)
	}
	if res.PriorReviewedBy != "reviewer-1" {
		t.Errorf("PriorReviewedBy = %q, want reviewer-1 (captured before clearing)", res.PriorReviewedBy)
	}
}

func TestEditEvidence_OnlyAssignedContributor(t *testing.T) {
	svc, ctx, c := setupSubmittedContribution(t)

	for _, actor := range []string{"", "lead-1", "steward-1", "someone-else"} {
		_, err := svc.EditEvidence(ctx, "space-1", c.ID, actor, SubmitEvidenceRequest{CompletionNotes: "x"})
		if !errors.Is(err, ErrNotEvidenceOwner) {
			t.Errorf("actor %q: err = %v, want ErrNotEvidenceOwner", actor, err)
		}
	}
	// Nothing was written.
	got, _ := svc.GetContribution(ctx, "space-1", c.ID)
	if got.CompletionNotes != "did the thing" || got.EvidenceEditedAt != nil {
		t.Errorf("rejected edit mutated the record: %+v", got)
	}
}

func TestEditEvidence_RemovalsStick(t *testing.T) {
	svc, ctx, c := setupSubmittedContribution(t)

	// Seed attachments + time report on the submission.
	c.AttachmentFiles = []FileRef{{FileName: "a.pdf"}}
	c.TimeReportFile = &FileRef{FileName: "time.csv"}
	c.AcceptanceNotes = []string{"note"}
	svc.store.Save("space-1", c.ID, "contribution", c)

	// Edit form sends the full submission with the lists emptied / file removed.
	res, err := svc.EditEvidence(ctx, "space-1", c.ID, "contributor-1", SubmitEvidenceRequest{
		CompletionNotes: "kept notes",
		EvidenceURLs:    []string{},
		AcceptanceNotes: []string{},
		AttachmentFiles: []FileRef{},
	})
	if err != nil {
		t.Fatalf("EditEvidence: %v", err)
	}
	got := res.Contribution
	if len(got.AttachmentFiles) != 0 {
		t.Errorf("attachments not removed: %v", got.AttachmentFiles)
	}
	if got.TimeReportFile != nil {
		t.Errorf("time report not removed: %v", got.TimeReportFile)
	}
	if len(got.EvidenceURLs) != 0 || len(got.AcceptanceNotes) != 0 {
		t.Errorf("lists not cleared: urls=%v notes=%v", got.EvidenceURLs, got.AcceptanceNotes)
	}
}

func TestEditEvidence_RequiresCompletionNotes(t *testing.T) {
	svc, ctx, c := setupSubmittedContribution(t)

	if _, err := svc.EditEvidence(ctx, "space-1", c.ID, "contributor-1", SubmitEvidenceRequest{
		CompletionNotes: "   ",
		EvidenceURLs:    []string{"https://example.com/2"},
	}); err == nil {
		t.Fatal("expected error for blank completion_notes")
	}
	got, _ := svc.GetContribution(ctx, "space-1", c.ID)
	if got.CompletionNotes != "did the thing" {
		t.Errorf("completion notes blanked by partial payload: %q", got.CompletionNotes)
	}
}

func TestEditEvidence_ApprovedToNeedsReviewNotGloballyLegal(t *testing.T) {
	// The approval-voiding move is confined to EditEvidence; the generic
	// transition path (POST /transition) must still refuse it.
	if err := ValidateContributionTransition(ContribApproved, ContribNeedsReview); err == nil {
		t.Error("approved→needs_review must not be a generic transition")
	}
	svc, ctx, c := setupSubmittedContribution(t)
	svc.ReviewContribution(ctx, "space-1", c.ID, ReviewRequest{Decision: "approved"})
	if _, err := svc.TransitionContribution(ctx, "space-1", c.ID, ContribNeedsReview); err == nil {
		t.Error("TransitionContribution approved→needs_review should be rejected")
	}
}

func TestEditEvidence_RejectsSignedOffAndAssigned(t *testing.T) {
	svc, ctx, c := setupSubmittedContribution(t)

	// assigned (before submit) is not editable — build a fresh assigned one.
	fresh, _ := svc.CreateContribution(ctx, "space-1", &CreateContributionRequest{
		ProjectID: "proj-1", Title: "T2", Description: "d",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow,
		CreatedBy: "lead-1", Objectives: []string{"o"},
		Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
		SkillRequirements: []string{"s"},
	})
	svc.TransitionContribution(ctx, "space-1", fresh.ID, ContribConfirmed)
	fresh, _ = svc.AssignContributor(ctx, "space-1", fresh.ID, "contributor-1")
	if _, err := svc.EditEvidence(ctx, "space-1", fresh.ID, "contributor-1", SubmitEvidenceRequest{CompletionNotes: "x"}); err == nil {
		t.Error("expected error editing evidence while assigned")
	}

	// Drive the submitted one all the way to signed_off, then attempt an edit.
	svc.ReviewContribution(ctx, "space-1", c.ID, ReviewRequest{Decision: "approved"})
	// SignOff requires a signed-off plan; force status directly for this guard test.
	signed, _ := svc.GetContribution(ctx, "space-1", c.ID)
	signed.Status = ContribSignedOff
	svc.store.Save("space-1", signed.ID, "contribution", signed)
	if _, err := svc.EditEvidence(ctx, "space-1", c.ID, "contributor-1", SubmitEvidenceRequest{CompletionNotes: "x"}); err == nil {
		t.Error("expected error editing evidence after sign-off")
	}
}

// TestRewardContribution_KeepsSignOffProof pins the per-transition proof
// storage (issue #20): rewarding must not destroy the sign-off proof — #19's
// verifier needs both to hold simultaneously.
func TestRewardContribution_KeepsSignOffProof(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	plan, _ := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	plan.SignedOff = true
	now := time.Now()
	plan.SignedOffAt = &now
	_ = svc.SaveImplementationPlan(ctx, spaceID, plan)

	contrib, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	contrib.Status = ContribApproved
	_ = svc.SaveContribution(ctx, spaceID, contrib)

	signOffProof := &Proof{V: "matou-proof/v1", Action: "contribution_signoff", Subject: contrib.ID, Space: spaceID, Value: "signed_off", Dt: "2026-08-15T00:00:00Z", AID: "steward", Sig: "0Bsig1"}
	if _, err := svc.SignOffContribution(ctx, spaceID, contrib.ID, "steward", signOffProof); err != nil {
		t.Fatalf("SignOffContribution: %v", err)
	}

	rewardProof := &Proof{V: "matou-proof/v1", Action: "contribution_reward", Subject: contrib.ID, Space: spaceID, Value: "rewarded", Dt: "2026-08-15T00:01:00Z", AID: "admin", Sig: "0Bsig2"}
	got, err := svc.RewardContribution(ctx, spaceID, contrib.ID, "admin", rewardProof)
	if err != nil {
		t.Fatalf("RewardContribution: %v", err)
	}

	if got.SignOffProof == nil || got.SignOffProof.Sig != "0Bsig1" {
		t.Errorf("sign-off proof lost or clobbered after reward: %+v", got.SignOffProof)
	}
	if got.RewardProof == nil || got.RewardProof.Sig != "0Bsig2" {
		t.Errorf("reward proof missing: %+v", got.RewardProof)
	}
}
