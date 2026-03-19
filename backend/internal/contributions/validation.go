// backend/internal/contributions/validation.go
package contributions

import "fmt"

// UnconfirmedContributionsError is returned when plan sign-off is attempted
// with contributions that have not yet reached the confirmed status.
type UnconfirmedContributionsError struct {
	IDs []string
}

func (e *UnconfirmedContributionsError) Error() string {
	return fmt.Sprintf("contributions not confirmed: %v", e.IDs)
}

// BlockingChildrenError is returned when a parent contribution cannot advance
// because one or more child contributions are not yet signed off.
type BlockingChildrenError struct {
	IDs []string
}

func (e *BlockingChildrenError) Error() string {
	return fmt.Sprintf("child contributions not signed off: %v", e.IDs)
}

// --- Proposal transitions ---

var proposalTransitions = map[ProposalStatus][]ProposalStatus{
	ProposalDraft:         {ProposalSubmitted},
	ProposalSubmitted:     {ProposalEndorsing, ProposalInReview},
	ProposalEndorsing:     {ProposalInReview},
	ProposalInReview:      {ProposalSignedOff, ProposalRejected, ProposalDraft},
	ProposalSignedOff:     {ProposalVotingProcess},
	ProposalVotingProcess: {ProposalApproved, ProposalRejected},
	ProposalApproved:      {ProposalCompleted},
}

func ValidateProposalTransition(from, to ProposalStatus) error {
	allowed, ok := proposalTransitions[from]
	if !ok {
		return fmt.Errorf("no transitions from status %q", from)
	}
	for _, s := range allowed {
		if s == to {
			return nil
		}
	}
	return fmt.Errorf("invalid proposal transition: %s → %s", from, to)
}

// --- Contribution transitions ---

var contributionTransitions = map[ContributionStatus][]ContributionStatus{
	ContribCreated:     {ContribConfirmed, ContribAssigned},
	ContribConfirmed:   {ContribShared, ContribOffered, ContribAssigned, ContribArchived},
	ContribShared:      {ContribOffered, ContribAssigned, ContribArchived},
	ContribOffered:     {ContribAssigned, ContribArchived},
	ContribAssigned:    {ContribChanged, ContribNeedsReview},
	ContribChanged:     {ContribConfirmed, ContribAssigned},
	ContribNeedsReview: {ContribApproved, ContribIncomplete, ContribDeclined},
	ContribIncomplete:  {ContribAssigned},
	ContribApproved:    {ContribSignedOff},
	ContribSignedOff:   {ContribRewarded},
	ContribRewarded:    {ContribArchived},
	ContribDeclined:    {ContribArchived},
}

func ValidateContributionTransition(from, to ContributionStatus) error {
	allowed, ok := contributionTransitions[from]
	if !ok {
		return fmt.Errorf("no transitions from status %q", from)
	}
	for _, s := range allowed {
		if s == to {
			return nil
		}
	}
	return fmt.Errorf("invalid contribution transition: %s → %s", from, to)
}

// --- Decision Plan transitions ---

var decisionPlanTransitions = map[DecisionPlanStatus][]DecisionPlanStatus{
	DecisionPlanDrafted:   {DecisionPlanSubmitted},
	DecisionPlanSubmitted: {DecisionPlanSignedOff},
}

func ValidateDecisionPlanTransition(from, to DecisionPlanStatus) error {
	allowed, ok := decisionPlanTransitions[from]
	if !ok {
		return fmt.Errorf("no transitions from status %q", from)
	}
	for _, s := range allowed {
		if s == to {
			return nil
		}
	}
	return fmt.Errorf("invalid decision plan transition: %s → %s", from, to)
}

// --- Governance Action transitions ---

var govActionTransitions = map[GovernanceActionStatus][]GovernanceActionStatus{
	GovActionPlanned:   {GovActionCompleted, GovActionArchived},
	GovActionCompleted: {GovActionArchived},
}

func ValidateGovernanceActionTransition(from, to GovernanceActionStatus) error {
	allowed, ok := govActionTransitions[from]
	if !ok {
		return fmt.Errorf("no transitions from status %q", from)
	}
	for _, s := range allowed {
		if s == to {
			return nil
		}
	}
	return fmt.Errorf("invalid governance action transition: %s → %s", from, to)
}

// --- Field validation ---

func ValidateProposal(p *Proposal) []string {
	var errs []string
	if p.ID == "" {
		errs = append(errs, "id is required")
	}
	if p.ProposerID == "" {
		errs = append(errs, "proposer_id is required")
	}
	if p.Title == "" {
		errs = append(errs, "title is required")
	}
	if len(p.Types) == 0 {
		errs = append(errs, "at least one type is required")
	}
	if p.Priority == "" {
		errs = append(errs, "priority is required")
	}
	if p.Description == "" {
		errs = append(errs, "description is required")
	}
	if p.ProblemStatement == "" {
		errs = append(errs, "problem_statement is required")
	}
	if p.Solution == "" {
		errs = append(errs, "solution is required")
	}
	if len(p.ExpectedOutcomes) == 0 {
		errs = append(errs, "at least one expected_outcome is required")
	}
	if p.EstimatedBudget == "" {
		errs = append(errs, "estimated_budget is required")
	}
	if p.Timeline == "" {
		errs = append(errs, "timeline is required")
	}
	return errs
}

func ValidateProject(p *Project) []string {
	var errs []string
	if p.ID == "" {
		errs = append(errs, "id is required")
	}
	if p.Title == "" {
		errs = append(errs, "title is required")
	}
	if p.Description == "" {
		errs = append(errs, "description is required")
	}
	if p.CreatedBy == "" {
		errs = append(errs, "created_by is required")
	}
	return errs
}

func ValidateContribution(c *Contribution) []string {
	var errs []string
	if c.ID == "" {
		errs = append(errs, "id is required")
	}
	if c.ProjectID == "" {
		errs = append(errs, "project_id is required")
	}
	if c.Title == "" {
		errs = append(errs, "title is required")
	}
	if c.Description == "" {
		errs = append(errs, "description is required")
	}
	if c.CreatedBy == "" {
		errs = append(errs, "created_by is required")
	}
	if len(c.Objectives) == 0 {
		errs = append(errs, "at least one objective is required")
	}
	if len(c.Deliverables) == 0 {
		errs = append(errs, "at least one deliverable is required")
	}
	if len(c.AcceptanceCriteria) == 0 {
		errs = append(errs, "at least one acceptance criterion is required")
	}
	if c.QualityRating != 0 && (c.QualityRating < 1 || c.QualityRating > 10) {
		errs = append(errs, "quality_rating must be between 1 and 10")
	}
	return errs
}

// ValidateNoCyclicDependency checks that adding depID as a dependency of contribID
// does not create a circular reference. deps maps each contribution ID to its dependencies.
func ValidateNoCyclicDependency(contribID, depID string, deps map[string][]string) error {
	visited := map[string]bool{}
	var walk func(id string) bool
	walk = func(id string) bool {
		if id == contribID {
			return true // cycle found
		}
		if visited[id] {
			return false
		}
		visited[id] = true
		for _, next := range deps[id] {
			if walk(next) {
				return true
			}
		}
		return false
	}
	if walk(depID) {
		return fmt.Errorf("adding dependency %s → %s would create a cycle", contribID, depID)
	}
	return nil
}

// ValidatePlanSignOff validates that an implementation plan is ready to be signed off.
// Requirements: at least one milestone, each milestone has contributions, all contributions are confirmed.
func ValidatePlanSignOff(plan *ImplementationPlan, milestones []Milestone, contributions []Contribution) error {
	if len(milestones) == 0 {
		return fmt.Errorf("plan must have at least one milestone")
	}
	for _, m := range milestones {
		if len(m.ContributionIDs) == 0 {
			return fmt.Errorf("milestone %q has no contributions", m.Title)
		}
	}
	var unconfirmed []string
	for _, c := range contributions {
		if c.Status != ContribConfirmed {
			unconfirmed = append(unconfirmed, c.ID)
		}
	}
	if len(unconfirmed) > 0 {
		return &UnconfirmedContributionsError{IDs: unconfirmed}
	}
	return nil
}

// ValidateParentSignOff ensures all child contributions are signed_off before
// the parent can transition to signed_off.
func ValidateParentSignOff(parentID string, childStatuses map[string]ContributionStatus) error {
	for childID, status := range childStatuses {
		if status != ContribSignedOff && status != ContribRewarded && status != ContribArchived {
			return fmt.Errorf("child contribution %s has status %s; all children must be signed_off before parent %s", childID, status, parentID)
		}
	}
	return nil
}
