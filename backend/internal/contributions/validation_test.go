// backend/internal/contributions/validation_test.go
package contributions

import "testing"

func TestProposalTransition_Valid(t *testing.T) {
	tests := []struct {
		from ProposalStatus
		to   ProposalStatus
	}{
		{ProposalDraft, ProposalSubmitted},
		{ProposalSubmitted, ProposalEndorsing},
		{ProposalEndorsing, ProposalInReview},
		{ProposalInReview, ProposalSignedOff},
		{ProposalInReview, ProposalDraft},
		{ProposalSignedOff, ProposalVotingProcess},
		{ProposalVotingProcess, ProposalApproved},
		{ProposalVotingProcess, ProposalRejected},
		{ProposalApproved, ProposalCompleted},
	}
	for _, tt := range tests {
		if err := ValidateProposalTransition(tt.from, tt.to); err != nil {
			t.Errorf("expected valid transition %s → %s, got error: %v", tt.from, tt.to, err)
		}
	}
}

func TestProposalTransition_Invalid(t *testing.T) {
	tests := []struct {
		from ProposalStatus
		to   ProposalStatus
	}{
		{ProposalDraft, ProposalApproved},
		{ProposalRejected, ProposalApproved},
		{ProposalCompleted, ProposalDraft},
		{ProposalEndorsing, ProposalSignedOff},
	}
	for _, tt := range tests {
		if err := ValidateProposalTransition(tt.from, tt.to); err == nil {
			t.Errorf("expected invalid transition %s → %s to fail", tt.from, tt.to)
		}
	}
}

func TestContributionTransition_Valid(t *testing.T) {
	tests := []struct {
		from ContributionStatus
		to   ContributionStatus
	}{
		{ContribCreated, ContribConfirmed},
		{ContribConfirmed, ContribAssigned},
		{ContribAssigned, ContribChanged},
		{ContribChanged, ContribConfirmed},
		{ContribAssigned, ContribNeedsReview},
		{ContribNeedsReview, ContribApproved},
		{ContribNeedsReview, ContribIncomplete},
		{ContribNeedsReview, ContribDeclined},
		{ContribIncomplete, ContribAssigned},
		{ContribApproved, ContribSignedOff},
		{ContribDeclined, ContribArchived},
	}
	for _, tt := range tests {
		if err := ValidateContributionTransition(tt.from, tt.to); err != nil {
			t.Errorf("expected valid transition %s → %s, got error: %v", tt.from, tt.to, err)
		}
	}
}

func TestContributionTransition_Invalid(t *testing.T) {
	tests := []struct {
		from ContributionStatus
		to   ContributionStatus
	}{
		{ContribCreated, ContribAssigned},
		{ContribAssigned, ContribApproved},
		{ContribArchived, ContribCreated},
	}
	for _, tt := range tests {
		if err := ValidateContributionTransition(tt.from, tt.to); err == nil {
			t.Errorf("expected invalid transition %s → %s to fail", tt.from, tt.to)
		}
	}
}

func TestDecisionPlanTransition_Valid(t *testing.T) {
	valid := []struct{ from, to DecisionPlanStatus }{
		{DecisionPlanDrafted, DecisionPlanSubmitted},
		{DecisionPlanSubmitted, DecisionPlanSignedOff},
	}
	for _, tt := range valid {
		if err := ValidateDecisionPlanTransition(tt.from, tt.to); err != nil {
			t.Errorf("expected valid transition %s → %s, got: %v", tt.from, tt.to, err)
		}
	}
}

func TestDecisionPlanTransition_Invalid(t *testing.T) {
	if err := ValidateDecisionPlanTransition(DecisionPlanDrafted, DecisionPlanSignedOff); err == nil {
		t.Error("expected drafted → signed_off to fail")
	}
}

func TestGovernanceActionTransition_Valid(t *testing.T) {
	valid := []struct{ from, to GovernanceActionStatus }{
		{GovActionPlanned, GovActionCompleted},
		{GovActionCompleted, GovActionArchived},
		{GovActionPlanned, GovActionArchived},
	}
	for _, tt := range valid {
		if err := ValidateGovernanceActionTransition(tt.from, tt.to); err != nil {
			t.Errorf("expected valid %s → %s, got: %v", tt.from, tt.to, err)
		}
	}
}

func TestValidateProposal_Required(t *testing.T) {
	p := &Proposal{} // empty
	errs := ValidateProposal(p)
	if len(errs) == 0 {
		t.Error("expected validation errors for empty proposal")
	}
}

func TestValidateProposal_Valid(t *testing.T) {
	p := &Proposal{
		ID:               "test-id",
		ProposerID:       "user-1",
		Title:            "Test Proposal",
		Types:            []ProposalType{ProposalTypeTechnical},
		Priority:         PriorityMedium,
		Description:      "A test proposal",
		ProblemStatement: "Problem",
		Solution:         "Solution",
		ExpectedOutcomes: []string{"outcome"},
		EstimatedBudget:  "$1000",
		Timeline:         "2 weeks",
	}
	errs := ValidateProposal(p)
	if len(errs) != 0 {
		t.Errorf("expected no errors, got: %v", errs)
	}
}

func TestValidateContribution_QualityRating(t *testing.T) {
	base := &Contribution{
		ID: "c1", ProjectID: "p1", Title: "T", Description: "D",
		CreatedBy: "u1", Objectives: []string{"o"}, Deliverables: []string{"d"},
		AcceptanceCriteria: []string{"a"},
	}
	// Valid: 0 (unset) should pass
	if errs := ValidateContribution(base); len(errs) != 0 {
		t.Errorf("expected no errors, got: %v", errs)
	}
	// Valid: 5
	base.QualityRating = 5
	if errs := ValidateContribution(base); len(errs) != 0 {
		t.Errorf("expected no errors for rating 5, got: %v", errs)
	}
	// Invalid: 11
	base.QualityRating = 11
	errs := ValidateContribution(base)
	found := false
	for _, e := range errs {
		if e == "quality_rating must be between 1 and 10" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected quality_rating error, got: %v", errs)
	}
}

func TestValidateNoCyclicDependency(t *testing.T) {
	deps := map[string][]string{
		"a": {"b"},
		"b": {"c"},
	}
	// No cycle: a depends on b, b depends on c, adding c→d is fine
	if err := ValidateNoCyclicDependency("c", "d", deps); err != nil {
		t.Errorf("expected no cycle, got: %v", err)
	}
	// Cycle: c depends on a would create a→b→c→a
	if err := ValidateNoCyclicDependency("c", "a", deps); err == nil {
		t.Error("expected cycle error for c→a")
	}
}

func TestValidateParentSignOff(t *testing.T) {
	// All children signed off — should pass
	children := map[string]ContributionStatus{
		"c1": ContribSignedOff,
		"c2": ContribRewarded,
	}
	if err := ValidateParentSignOff("parent", children); err != nil {
		t.Errorf("expected pass, got: %v", err)
	}
	// One child still assigned — should fail
	children["c3"] = ContribAssigned
	if err := ValidateParentSignOff("parent", children); err == nil {
		t.Error("expected error for incomplete child")
	}
}
