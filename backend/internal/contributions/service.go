// backend/internal/contributions/service.go
package contributions

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

var ErrNotFound = errors.New("not found")

// ObjectStore abstracts any-sync object tree operations for testability.
type ObjectStore interface {
	Save(spaceID, objectID, objectType string, data interface{}) error
	Get(spaceID, objectID string, dest interface{}) error
	List(spaceID, objectType string) ([]json.RawMessage, error)
	Delete(spaceID, objectID string) error
}

// Service provides business logic for the contributions system.
type Service struct {
	store ObjectStore
}

func NewService(store ObjectStore) *Service {
	return &Service{store: store}
}

func generateID(prefix string) string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// Fallback to timestamp-based ID if crypto/rand fails
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return fmt.Sprintf("%s_%x", prefix, b)
}

// --- Proposals ---

type CreateProposalRequest struct {
	ProposerID       string            `json:"proposer_id"`
	Title            string            `json:"title"`
	Types            []ProposalType    `json:"type"`
	Priority         Priority          `json:"priority"`
	Description      string            `json:"description"`
	ProblemStatement string            `json:"problem_statement"`
	Solution         string            `json:"solution"`
	ExpectedOutcomes []string          `json:"expected_outcomes"`
	EstimatedBudget  string            `json:"estimated_budget"`
	Timeline         string            `json:"timeline"`
	ProjectPlan          []ProjectPlanItem `json:"project_plan,omitempty"`
	Attachments          []Attachment      `json:"attachments,omitempty"`
	EndorsementThreshold int               `json:"endorsement_threshold,omitempty"`
}

func (s *Service) CreateProposal(ctx context.Context, spaceID string, req *CreateProposalRequest) (*Proposal, error) {
	now := time.Now()
	p := &Proposal{
		ID:                   generateID("prop"),
		ProposerID:           req.ProposerID,
		Title:                req.Title,
		Types:                req.Types,
		Priority:             req.Priority,
		Description:          req.Description,
		ProblemStatement:     req.ProblemStatement,
		Solution:             req.Solution,
		ExpectedOutcomes:     req.ExpectedOutcomes,
		EstimatedBudget:      req.EstimatedBudget,
		Timeline:             req.Timeline,
		ProjectPlan:          req.ProjectPlan,
		Attachments:          req.Attachments,
		EndorsementThreshold: req.EndorsementThreshold,
		Status:               ProposalDraft,
		CreatedAt:            now,
		UpdatedAt:            now,
	}

	errs := ValidateProposal(p)
	if len(errs) > 0 {
		return nil, fmt.Errorf("validation failed: %v", errs)
	}

	if err := s.store.Save(spaceID, p.ID, "proposal", p); err != nil {
		return nil, fmt.Errorf("saving proposal: %w", err)
	}
	return p, nil
}

func (s *Service) GetProposal(ctx context.Context, spaceID, proposalID string) (*Proposal, error) {
	var p Proposal
	if err := s.store.Get(spaceID, proposalID, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Service) ListProposals(ctx context.Context, spaceID string) ([]*Proposal, error) {
	raw, err := s.store.List(spaceID, "proposal")
	if err != nil {
		return nil, err
	}
	var proposals []*Proposal
	for _, r := range raw {
		var p Proposal
		if err := json.Unmarshal(r, &p); err == nil {
			proposals = append(proposals, &p)
		}
	}
	return proposals, nil
}

func (s *Service) TransitionProposal(ctx context.Context, spaceID, proposalID string, newStatus ProposalStatus) (*Proposal, error) {
	p, err := s.GetProposal(ctx, spaceID, proposalID)
	if err != nil {
		return nil, err
	}
	if err := ValidateProposalTransition(p.Status, newStatus); err != nil {
		return nil, err
	}
	// Require Lead and Steward roles before sign-off
	if p.Status == ProposalInReview && newStatus == ProposalSignedOff {
		if p.ProposalLeadID == "" {
			return nil, fmt.Errorf("proposal lead must be assigned before sign-off")
		}
		if p.ProposalStewardID == "" {
			return nil, fmt.Errorf("proposal steward must be assigned before sign-off")
		}
	}
	p.Status = newStatus
	p.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, p.ID, "proposal", p); err != nil {
		return nil, err
	}
	return p, nil
}

type UpdateProposalRequest struct {
	Title             *string      `json:"title,omitempty"`
	Description       *string      `json:"description,omitempty"`
	ProblemStatement  *string      `json:"problem_statement,omitempty"`
	Solution          *string      `json:"solution,omitempty"`
	ExpectedOutcomes  []string     `json:"expected_outcomes,omitempty"`
	EstimatedBudget   *string      `json:"estimated_budget,omitempty"`
	Timeline          *string      `json:"timeline,omitempty"`
	ProposalLeadID    *string      `json:"proposal_lead_id,omitempty"`
	ProposalStewardID *string      `json:"proposal_steward_id,omitempty"`
	Attachments       []Attachment `json:"attachments,omitempty"`
}

func (s *Service) UpdateProposal(ctx context.Context, spaceID, proposalID string, req *UpdateProposalRequest) (*Proposal, error) {
	p, err := s.GetProposal(ctx, spaceID, proposalID)
	if err != nil {
		return nil, err
	}
	if req.Title != nil {
		p.Title = *req.Title
	}
	if req.Description != nil {
		p.Description = *req.Description
	}
	if req.ProblemStatement != nil {
		p.ProblemStatement = *req.ProblemStatement
	}
	if req.Solution != nil {
		p.Solution = *req.Solution
	}
	if req.ExpectedOutcomes != nil {
		p.ExpectedOutcomes = req.ExpectedOutcomes
	}
	if req.EstimatedBudget != nil {
		p.EstimatedBudget = *req.EstimatedBudget
	}
	if req.Timeline != nil {
		p.Timeline = *req.Timeline
	}
	if req.ProposalLeadID != nil {
		p.ProposalLeadID = *req.ProposalLeadID
	}
	if req.ProposalStewardID != nil {
		p.ProposalStewardID = *req.ProposalStewardID
	}
	if req.Attachments != nil {
		p.Attachments = req.Attachments
	}
	p.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, p.ID, "proposal", p); err != nil {
		return nil, err
	}
	return p, nil
}

func (s *Service) AddHistoryEntry(ctx context.Context, spaceID string, entry *ProposalHistoryEntry) error {
	entry.ID = generateID("hist")
	entry.CreatedAt = time.Now()
	return s.store.Save(spaceID, entry.ID, "proposal_history", entry)
}

func (s *Service) ListHistory(ctx context.Context, spaceID, proposalID string) ([]*ProposalHistoryEntry, error) {
	raw, err := s.store.List(spaceID, "proposal_history")
	if err != nil {
		return nil, err
	}
	var entries []*ProposalHistoryEntry
	for _, r := range raw {
		var e ProposalHistoryEntry
		if err := json.Unmarshal(r, &e); err == nil {
			if e.ProposalID == proposalID {
				entries = append(entries, &e)
			}
		}
	}
	return entries, nil
}

// --- Endorsements ---

func endorsementKey(proposalID, endorserID string) string {
	return fmt.Sprintf("endorse_%s_%s", proposalID, endorserID)
}

type EndorsementResult struct {
	Endorsement  *Endorsement `json:"endorsement"`
	ThresholdMet bool         `json:"threshold_met"`
	NewStatus    string       `json:"new_status,omitempty"`
}

func (s *Service) AddEndorsement(ctx context.Context, spaceID, proposalID string, e *Endorsement) (*EndorsementResult, error) {
	p, err := s.GetProposal(ctx, spaceID, proposalID)
	if err != nil {
		return nil, fmt.Errorf("proposal not found: %w", err)
	}
	if p.Status != ProposalSubmitted && p.Status != ProposalEndorsing {
		return nil, fmt.Errorf("proposal must be in submitted or endorsing status, currently: %s", p.Status)
	}
	key := endorsementKey(proposalID, e.EndorserID)
	if err := s.store.Save(spaceID, key, "endorsement", e); err != nil {
		return nil, err
	}

	result := &EndorsementResult{Endorsement: e}

	// Check threshold
	endorsements, err := s.GetEndorsements(ctx, spaceID, proposalID)
	if err == nil {
		threshold := p.EndorsementThreshold
		if threshold <= 0 {
			threshold = 1
		}
		if len(endorsements) >= threshold {
			result.ThresholdMet = true
			// Auto-transition to in_review
			p.Status = ProposalInReview
			p.UpdatedAt = time.Now()
			if err := s.store.Save(spaceID, p.ID, "proposal", p); err == nil {
				result.NewStatus = string(ProposalInReview)
				// Auto-create role contributions
				s.CreateRoleContributions(ctx, spaceID, p)
				// Record history
				s.AddHistoryEntry(ctx, spaceID, &ProposalHistoryEntry{
					ProposalID: proposalID,
					UserID:     "system",
					Action:     "Endorsement threshold met - moved to In Review",
				})
			}
		}
	}

	return result, nil
}

// --- Proposal Comments ---

func (s *Service) AddProposalComment(ctx context.Context, spaceID string, comment *ProposalComment) (*ProposalComment, error) {
	comment.ID = generateID("pcmt")
	comment.CreatedAt = time.Now()
	if err := s.store.Save(spaceID, comment.ID, "proposal_comment", comment); err != nil {
		return nil, err
	}
	return comment, nil
}

func (s *Service) ListProposalComments(ctx context.Context, spaceID, proposalID string) ([]*ProposalComment, error) {
	raw, err := s.store.List(spaceID, "proposal_comment")
	if err != nil {
		return nil, err
	}
	var comments []*ProposalComment
	for _, r := range raw {
		var c ProposalComment
		if err := json.Unmarshal(r, &c); err == nil {
			if c.ProposalID == proposalID {
				comments = append(comments, &c)
			}
		}
	}
	return comments, nil
}

func (s *Service) CreateRoleContributions(ctx context.Context, spaceID string, proposal *Proposal) {
	// Create Proposal Lead contribution
	leadID := generateID("ctr")
	leadContrib := &Contribution{
		ID:               leadID,
		ProjectID:        "proposals",
		Title:            fmt.Sprintf("Proposal Lead - %s", proposal.Title),
		Description:      fmt.Sprintf("Lead reviewer for proposal: %s", proposal.Title),
		ContributionType: ProposalTypeGovernance,
		Priority:         proposal.Priority,
		CreatedBy:        "system",
		Objectives:       []string{"Review and sign off proposal"},
		Deliverables:     []string{"Proposal review and sign-off"},
		AcceptanceCriteria: []string{"Proposal reviewed and decision made"},
		Status:           ContribCreated,
		CreatedAt:        time.Now(),
		UpdatedAt:        time.Now(),
	}
	if err := s.store.Save(spaceID, leadID, "contribution", leadContrib); err == nil {
		proposal.LeadContributionID = leadID
	}

	// Create Proposal Steward contribution
	stewardID := generateID("ctr")
	stewardContrib := &Contribution{
		ID:               stewardID,
		ProjectID:        "proposals",
		Title:            fmt.Sprintf("Proposal Steward - %s", proposal.Title),
		Description:      fmt.Sprintf("Steward reviewer for proposal: %s", proposal.Title),
		ContributionType: ProposalTypeGovernance,
		Priority:         proposal.Priority,
		CreatedBy:        "system",
		Objectives:       []string{"Review and sign off decision plan"},
		Deliverables:     []string{"Decision plan review and sign-off"},
		AcceptanceCriteria: []string{"Decision plan reviewed and signed off"},
		Status:           ContribCreated,
		CreatedAt:        time.Now(),
		UpdatedAt:        time.Now(),
	}
	if err := s.store.Save(spaceID, stewardID, "contribution", stewardContrib); err == nil {
		proposal.StewardContributionID = stewardID
	}

	// Save updated proposal with contribution IDs
	s.store.Save(spaceID, proposal.ID, "proposal", proposal)

	// Record history
	s.AddHistoryEntry(ctx, spaceID, &ProposalHistoryEntry{
		ProposalID: proposal.ID,
		UserID:     "system",
		Action:     "Created Proposal Lead contribution request",
	})
	s.AddHistoryEntry(ctx, spaceID, &ProposalHistoryEntry{
		ProposalID: proposal.ID,
		UserID:     "system",
		Action:     "Created Proposal Steward contribution request",
	})
}

func (s *Service) GetEndorsements(ctx context.Context, spaceID, proposalID string) ([]*Endorsement, error) {
	raw, err := s.store.List(spaceID, "endorsement")
	if err != nil {
		return nil, err
	}
	var endorsements []*Endorsement
	for _, r := range raw {
		var e Endorsement
		if err := json.Unmarshal(r, &e); err == nil {
			endorsements = append(endorsements, &e)
		}
	}
	return endorsements, nil
}

// --- Projects ---

type CreateProjectRequest struct {
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Images      []ProjectImage `json:"images,omitempty"`
	CreatedBy   string         `json:"created_by"`
}

type UpdateProjectRequest struct {
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description,omitempty"`
	Images      []ProjectImage `json:"images,omitempty"`
}

func (s *Service) CreateProject(ctx context.Context, spaceID string, req *CreateProjectRequest) (*Project, error) {
	now := time.Now()
	p := &Project{
		ID:          generateID("proj"),
		Title:       req.Title,
		Description: req.Description,
		Status:      ProjectCreated,
		Images:      req.Images,
		CreatedBy:   req.CreatedBy,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	errs := ValidateProject(p)
	if len(errs) > 0 {
		return nil, fmt.Errorf("validation failed: %v", errs)
	}
	if err := s.store.Save(spaceID, p.ID, "project", p); err != nil {
		return nil, fmt.Errorf("saving project: %w", err)
	}
	return p, nil
}

func (s *Service) GetProject(ctx context.Context, spaceID, projectID string) (*Project, error) {
	var p Project
	if err := s.store.Get(spaceID, projectID, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Service) ListProjects(ctx context.Context, spaceID string) ([]*Project, error) {
	raw, err := s.store.List(spaceID, "project")
	if err != nil {
		return nil, err
	}
	var projects []*Project
	for _, r := range raw {
		var p Project
		if err := json.Unmarshal(r, &p); err == nil {
			projects = append(projects, &p)
		}
	}
	return projects, nil
}

func (s *Service) UpdateProject(ctx context.Context, spaceID, projectID string, req *UpdateProjectRequest) (*Project, error) {
	p, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil {
		return nil, err
	}
	if req.Title != "" {
		p.Title = req.Title
	}
	if req.Description != "" {
		p.Description = req.Description
	}
	if req.Images != nil {
		p.Images = req.Images
	}
	p.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, p.ID, "project", p); err != nil {
		return nil, err
	}
	return p, nil
}

func (s *Service) DeleteProject(ctx context.Context, spaceID, projectID string) error {
	p, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil {
		return err
	}
	if len(p.ImplementationPlanIDs) > 0 {
		return fmt.Errorf("cannot delete project with active implementation plans")
	}
	return s.store.Delete(spaceID, projectID)
}

func (s *Service) LinkProposalToProject(ctx context.Context, spaceID, projectID, proposalID string) (*Project, error) {
	p, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil {
		return nil, err
	}
	for _, id := range p.ProposalIDs {
		if id == proposalID {
			return p, nil // already linked
		}
	}
	p.ProposalIDs = append(p.ProposalIDs, proposalID)
	p.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, p.ID, "project", p); err != nil {
		return nil, err
	}
	return p, nil
}

func (s *Service) AutoCreateProjectForProposal(ctx context.Context, spaceID, proposalID, createdBy string) (*Project, error) {
	prop, err := s.GetProposal(ctx, spaceID, proposalID)
	if err != nil {
		return nil, fmt.Errorf("proposal not found: %w", err)
	}
	project, err := s.CreateProject(ctx, spaceID, &CreateProjectRequest{
		Title:       prop.Title,
		Description: prop.Description,
		CreatedBy:   createdBy,
	})
	if err != nil {
		return nil, err
	}
	return s.LinkProposalToProject(ctx, spaceID, project.ID, proposalID)
}

// --- Decision Plans ---

type CreateDecisionPlanRequest struct {
	ProposalID        string   `json:"proposal_id"`
	Title             string   `json:"title"`
	Description       string   `json:"description"`
	Objectives        []string `json:"objectives"`
	ExpectedOutcomes  []string `json:"expected_outcomes"`
	ProposalLeadID    string   `json:"proposal_lead_id"`
	ProposalStewardID string   `json:"proposal_steward_id"`
}

func (s *Service) CreateDecisionPlan(ctx context.Context, spaceID string, req *CreateDecisionPlanRequest) (*DecisionPlan, error) {
	now := time.Now()
	dp := &DecisionPlan{
		ID:                generateID("dp"),
		ProposalID:        req.ProposalID,
		Title:             req.Title,
		Description:       req.Description,
		Status:            DecisionPlanDrafted,
		Objectives:        req.Objectives,
		ExpectedOutcomes:  req.ExpectedOutcomes,
		ProposalLeadID:    req.ProposalLeadID,
		ProposalStewardID: req.ProposalStewardID,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := s.store.Save(spaceID, dp.ID, "decision_plan", dp); err != nil {
		return nil, err
	}
	return dp, nil
}

func (s *Service) GetDecisionPlan(ctx context.Context, spaceID, dpID string) (*DecisionPlan, error) {
	var dp DecisionPlan
	if err := s.store.Get(spaceID, dpID, &dp); err != nil {
		return nil, err
	}
	s.hydrateDecisionPlanActions(spaceID, &dp)
	return &dp, nil
}

func (s *Service) ListDecisionPlans(ctx context.Context, spaceID string) ([]*DecisionPlan, error) {
	raw, err := s.store.List(spaceID, "decision_plan")
	if err != nil {
		return nil, err
	}
	var plans []*DecisionPlan
	for _, r := range raw {
		var dp DecisionPlan
		if err := json.Unmarshal(r, &dp); err == nil {
			s.hydrateDecisionPlanActions(spaceID, &dp)
			plans = append(plans, &dp)
		}
	}
	return plans, nil
}

func (s *Service) hydrateDecisionPlanActions(spaceID string, dp *DecisionPlan) {
	raw, err := s.store.List(spaceID, "governance_action")
	if err != nil {
		return
	}
	var actions []GovernanceAction
	for _, r := range raw {
		var a GovernanceAction
		if err := json.Unmarshal(r, &a); err == nil {
			if a.DecisionPlanID == dp.ID {
				actions = append(actions, a)
			}
		}
	}
	dp.GovernanceActions = actions
}

func (s *Service) TransitionDecisionPlan(ctx context.Context, spaceID, dpID string, newStatus DecisionPlanStatus) (*DecisionPlan, error) {
	dp, err := s.GetDecisionPlan(ctx, spaceID, dpID)
	if err != nil {
		return nil, err
	}
	if err := ValidateDecisionPlanTransition(dp.Status, newStatus); err != nil {
		return nil, err
	}
	dp.Status = newStatus
	dp.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, dp.ID, "decision_plan", dp); err != nil {
		return nil, err
	}

	// Auto-transition proposal to voting_process when decision plan is signed off
	if newStatus == DecisionPlanSignedOff && dp.ProposalID != "" {
		p, err := s.GetProposal(ctx, spaceID, dp.ProposalID)
		if err == nil && p.Status == ProposalSignedOff {
			if err := ValidateProposalTransition(p.Status, ProposalVotingProcess); err == nil {
				p.Status = ProposalVotingProcess
				p.UpdatedAt = time.Now()
				s.store.Save(spaceID, p.ID, "proposal", p)
				s.AddHistoryEntry(ctx, spaceID, &ProposalHistoryEntry{
					ProposalID: dp.ProposalID,
					UserID:     "system",
					Action:     "Decision plan signed off - moved to voting process",
				})
			}
		}
	}

	return dp, nil
}

// --- Governance Actions ---

type CreateGovernanceActionRequest struct {
	DecisionPlanID  string     `json:"decision_plan_id"`
	House           HouseType  `json:"house"`
	ActionType      ActionType `json:"action_type"`
	Description     string     `json:"description"`
	MeetingDate     string     `json:"meeting_date,omitempty"`
	MeetingTime     string     `json:"meeting_time,omitempty"`
	MeetingLocation string     `json:"meeting_location,omitempty"`
	LinkedActionID  string     `json:"linked_action_id,omitempty"`
}

func (s *Service) AddGovernanceAction(ctx context.Context, spaceID string, req *CreateGovernanceActionRequest) (*GovernanceAction, error) {
	now := time.Now()
	action := &GovernanceAction{
		ID:              generateID("ga"),
		DecisionPlanID:  req.DecisionPlanID,
		House:           req.House,
		ActionType:      req.ActionType,
		Description:     req.Description,
		MeetingDate:     req.MeetingDate,
		MeetingTime:     req.MeetingTime,
		MeetingLocation: req.MeetingLocation,
		LinkedActionID:  req.LinkedActionID,
		Status:          GovActionPlanned,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := s.store.Save(spaceID, action.ID, "governance_action", action); err != nil {
		return nil, err
	}
	return action, nil
}

func (s *Service) GetGovernanceAction(ctx context.Context, spaceID, actionID string) (*GovernanceAction, error) {
	var action GovernanceAction
	if err := s.store.Get(spaceID, actionID, &action); err != nil {
		return nil, err
	}
	return &action, nil
}

func (s *Service) CompleteGovernanceAction(ctx context.Context, spaceID, actionID string, outcome OutcomeType) (*GovernanceAction, error) {
	action, err := s.GetGovernanceAction(ctx, spaceID, actionID)
	if err != nil {
		return nil, err
	}
	if err := ValidateGovernanceActionTransition(action.Status, GovActionCompleted); err != nil {
		return nil, err
	}
	action.Status = GovActionCompleted
	action.Outcome = outcome
	action.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, action.ID, "governance_action", action); err != nil {
		return nil, err
	}

	// If this was a decision action, check if all decisions are now complete
	if action.ActionType == ActionDecision {
		// Find the proposal ID through the decision plan
		dp, err := s.GetDecisionPlan(ctx, spaceID, action.DecisionPlanID)
		if err == nil && dp.ProposalID != "" {
			s.EvaluateGovernanceOutcome(ctx, spaceID, dp.ProposalID)
		}
	}

	return action, nil
}

// --- Implementation Plans ---

type CreateImplementationPlanRequest struct {
	ProjectID        string `json:"project_id"`
	TotalBudget      string `json:"total_budget"`
	ProjectLeadID    string `json:"project_lead"`
	ProjectStewardID string `json:"project_steward_id"`
}

func (s *Service) CreateImplementationPlan(ctx context.Context, spaceID string, req *CreateImplementationPlanRequest) (*ImplementationPlan, error) {
	now := time.Now()
	ip := &ImplementationPlan{
		ID:               generateID("ip"),
		ProjectID:        req.ProjectID,
		TotalBudget:      req.TotalBudget,
		ProjectLeadID:    req.ProjectLeadID,
		ProjectStewardID: req.ProjectStewardID,
		CurrentStatus:    "created",
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if err := s.store.Save(spaceID, ip.ID, "implementation_plan", ip); err != nil {
		return nil, err
	}
	return ip, nil
}

func (s *Service) GetImplementationPlan(ctx context.Context, spaceID, ipID string) (*ImplementationPlan, error) {
	var ip ImplementationPlan
	if err := s.store.Get(spaceID, ipID, &ip); err != nil {
		return nil, err
	}
	return &ip, nil
}

func (s *Service) ListImplementationPlans(ctx context.Context, spaceID string) ([]*ImplementationPlan, error) {
	raw, err := s.store.List(spaceID, "implementation_plan")
	if err != nil {
		return nil, err
	}
	var plans []*ImplementationPlan
	for _, r := range raw {
		var ip ImplementationPlan
		if err := json.Unmarshal(r, &ip); err == nil {
			plans = append(plans, &ip)
		}
	}
	return plans, nil
}

// --- Milestones ---

type CreateMilestoneRequest struct {
	ImplementationPlanID string `json:"implementation_plan_id"`
	Title                string `json:"title"`
	Duration             string `json:"duration"`
}

func (s *Service) AddMilestone(ctx context.Context, spaceID string, req *CreateMilestoneRequest) (*Milestone, error) {
	ms := &Milestone{
		MilestoneID:          generateID("ms"),
		ImplementationPlanID: req.ImplementationPlanID,
		Title:                req.Title,
		Duration:             req.Duration,
	}
	if err := s.store.Save(spaceID, ms.MilestoneID, "milestone", ms); err != nil {
		return nil, err
	}
	return ms, nil
}

// --- Contributions ---

type CreateContributionRequest struct {
	ProjectID            string       `json:"project_id"`
	Title                string       `json:"title"`
	Description          string       `json:"description"`
	ContributionType     ProposalType `json:"contribution_type"`
	Priority             Priority     `json:"priority"`
	CreatedBy            string       `json:"created_by"`
	Objectives           []string     `json:"objectives"`
	Deliverables         []string     `json:"deliverables"`
	AcceptanceCriteria   []string     `json:"acceptance_criteria"`
	SkillRequirements    []string     `json:"skill_requirements"`
	MilestoneID          string       `json:"milestone_id,omitempty"`
	ParentContributionID string       `json:"parent_contribution,omitempty"`
	EstimatedDuration    int          `json:"estimated_duration,omitempty"`
	Tags                 []string     `json:"tags,omitempty"`
}

func (s *Service) CreateContribution(ctx context.Context, spaceID string, req *CreateContributionRequest) (*Contribution, error) {
	now := time.Now()
	c := &Contribution{
		ID:                   generateID("ctr"),
		ProjectID:            req.ProjectID,
		Title:                req.Title,
		Description:          req.Description,
		ContributionType:     req.ContributionType,
		Priority:             req.Priority,
		CreatedBy:            req.CreatedBy,
		Objectives:           req.Objectives,
		Deliverables:         req.Deliverables,
		AcceptanceCriteria:   req.AcceptanceCriteria,
		SkillRequirements:    req.SkillRequirements,
		MilestoneID:          req.MilestoneID,
		ParentContributionID: req.ParentContributionID,
		EstimatedDuration:    req.EstimatedDuration,
		Tags:                 req.Tags,
		Status:               ContribCreated,
		CreatedAt:            now,
		UpdatedAt:            now,
	}
	errs := ValidateContribution(c)
	if len(errs) > 0 {
		return nil, fmt.Errorf("validation failed: %v", errs)
	}
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, err
	}
	return c, nil
}

func (s *Service) GetContribution(ctx context.Context, spaceID, contribID string) (*Contribution, error) {
	var c Contribution
	if err := s.store.Get(spaceID, contribID, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *Service) ListContributions(ctx context.Context, spaceID string) ([]*Contribution, error) {
	raw, err := s.store.List(spaceID, "contribution")
	if err != nil {
		return nil, err
	}
	var contribs []*Contribution
	for _, r := range raw {
		var c Contribution
		if err := json.Unmarshal(r, &c); err == nil {
			contribs = append(contribs, &c)
		}
	}
	return contribs, nil
}

func (s *Service) TransitionContribution(ctx context.Context, spaceID, contribID string, newStatus ContributionStatus) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contribID)
	if err != nil {
		return nil, err
	}
	if err := ValidateContributionTransition(c.Status, newStatus); err != nil {
		return nil, err
	}

	// If transitioning to signed_off, verify all child contributions are complete
	if newStatus == ContribSignedOff && len(c.ChildContributionIDs) > 0 {
		childStatuses := make(map[string]ContributionStatus)
		for _, childID := range c.ChildContributionIDs {
			child, err := s.GetContribution(ctx, spaceID, childID)
			if err != nil {
				return nil, fmt.Errorf("failed to check child %s: %w", childID, err)
			}
			childStatuses[childID] = child.Status
		}
		if err := ValidateParentSignOff(c.ID, childStatuses); err != nil {
			return nil, err
		}
	}

	c.Status = newStatus
	c.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, err
	}
	return c, nil
}

// --- Contribution Registration ---

func (s *Service) RegisterInterest(ctx context.Context, spaceID, contribID, userID, statement string) (*ContributionRegistration, error) {
	c, err := s.GetContribution(ctx, spaceID, contribID)
	if err != nil {
		return nil, fmt.Errorf("contribution not found: %w", err)
	}
	if c.Status != ContribConfirmed {
		return nil, fmt.Errorf("can only register interest on confirmed contributions, current status: %s", c.Status)
	}
	reg := &ContributionRegistration{
		ID:             generateID("reg"),
		ContributionID: contribID,
		UserID:         userID,
		Statement:      statement,
		RegisteredAt:   time.Now(),
	}
	if err := s.store.Save(spaceID, reg.ID, "contribution_registration", reg); err != nil {
		return nil, err
	}
	return reg, nil
}

func (s *Service) ListRegistrations(ctx context.Context, spaceID, contribID string) ([]*ContributionRegistration, error) {
	raw, err := s.store.List(spaceID, "contribution_registration")
	if err != nil {
		return nil, err
	}
	var regs []*ContributionRegistration
	for _, r := range raw {
		var reg ContributionRegistration
		if err := json.Unmarshal(r, &reg); err == nil {
			if reg.ContributionID == contribID {
				regs = append(regs, &reg)
			}
		}
	}
	return regs, nil
}

func (s *Service) AssignContributor(ctx context.Context, spaceID, contribID, userID string) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contribID)
	if err != nil {
		return nil, err
	}
	if c.Status != ContribConfirmed {
		return nil, fmt.Errorf("contribution must be confirmed to assign, current: %s", c.Status)
	}
	c.AssignedContributorID = userID
	c.Status = ContribAssigned
	c.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, err
	}
	return c, nil
}

// SaveContribution persists a contribution after external updates (e.g., evidence, review feedback).
func (s *Service) SaveContribution(ctx context.Context, spaceID string, c *Contribution) error {
	c.UpdatedAt = time.Now()
	return s.store.Save(spaceID, c.ID, "contribution", c)
}

// --- Project Status Derivation ---

// DeriveProjectStatus computes the project status from its implementation plans.
// - No plans → created
// - Any plan in progress → active
// - All plans completed → completed
// - Otherwise → created
func (s *Service) DeriveProjectStatus(ctx context.Context, spaceID, projectID string) ProjectStatus {
	plans, err := s.ListImplementationPlans(ctx, spaceID)
	if err != nil || len(plans) == 0 {
		return ProjectCreated
	}
	projectPlans := make([]*ImplementationPlan, 0)
	for _, p := range plans {
		if p.ProjectID == projectID {
			projectPlans = append(projectPlans, p)
		}
	}
	if len(projectPlans) == 0 {
		return ProjectCreated
	}
	allCompleted := true
	for _, p := range projectPlans {
		if p.CurrentStatus != "completed" {
			allCompleted = false
			break
		}
	}
	if allCompleted {
		return ProjectCompleted
	}
	return ProjectActive
}

// RefreshProjectStatus re-derives and persists the project's status.
func (s *Service) RefreshProjectStatus(ctx context.Context, spaceID, projectID string) (*Project, error) {
	proj, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil {
		return nil, err
	}
	newStatus := s.DeriveProjectStatus(ctx, spaceID, projectID)
	if proj.Status != newStatus {
		proj.Status = newStatus
		proj.UpdatedAt = time.Now()
		if err := s.store.Save(spaceID, proj.ID, "project", proj); err != nil {
			return nil, err
		}
	}
	return proj, nil
}

// EvaluateGovernanceOutcome checks all decision actions for a proposal's decision plan
// and auto-transitions the proposal to approved or rejected when all decisions are complete.
func (s *Service) EvaluateGovernanceOutcome(ctx context.Context, spaceID, proposalID string) error {
	// Find decision plan for this proposal
	plans, err := s.ListDecisionPlans(ctx, spaceID)
	if err != nil {
		return err
	}
	var dp *DecisionPlan
	for _, p := range plans {
		if p.ProposalID == proposalID {
			dp = p
			break
		}
	}
	if dp == nil {
		return fmt.Errorf("no decision plan found for proposal %s", proposalID)
	}

	// Load all governance actions for this plan
	raw, err := s.store.List(spaceID, "governance_action")
	if err != nil {
		return err
	}
	var actions []*GovernanceAction
	for _, r := range raw {
		var a GovernanceAction
		if err := json.Unmarshal(r, &a); err == nil {
			if a.DecisionPlanID == dp.ID && a.ActionType == ActionDecision {
				actions = append(actions, &a)
			}
		}
	}

	if len(actions) == 0 {
		return nil
	}

	// Check if all decision actions are completed
	allCompleted := true
	allFavorable := true
	for _, a := range actions {
		if a.Status != GovActionCompleted {
			allCompleted = false
			break
		}
		if a.Outcome == OutcomeVeto || a.Outcome == OutcomeRejected {
			allFavorable = false
		}
	}

	if !allCompleted {
		return nil
	}

	// All decision actions completed - determine outcome
	if allFavorable {
		s.TransitionProposal(ctx, spaceID, proposalID, ProposalApproved)
		s.AddHistoryEntry(ctx, spaceID, &ProposalHistoryEntry{
			ProposalID: proposalID,
			UserID:     "system",
			Action:     "All governance votes favorable - proposal approved",
		})
	} else {
		s.TransitionProposal(ctx, spaceID, proposalID, ProposalRejected)
		s.AddHistoryEntry(ctx, spaceID, &ProposalHistoryEntry{
			ProposalID: proposalID,
			UserID:     "system",
			Action:     "Governance vote unfavorable - proposal rejected",
		})
	}

	return nil
}
