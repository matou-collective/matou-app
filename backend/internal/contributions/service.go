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

// SaveProject persists a project that was modified externally (e.g. role assignment).
func (s *Service) SaveProject(ctx context.Context, spaceID string, p *Project) error {
	return s.store.Save(spaceID, p.ID, "project", p)
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

// GetProjectByProposalID returns the project linked to the given proposal, or nil if none exists.
func (s *Service) GetProjectByProposalID(ctx context.Context, spaceID, proposalID string) (*Project, error) {
	projects, err := s.ListProjects(ctx, spaceID)
	if err != nil {
		return nil, err
	}
	for _, p := range projects {
		for _, pid := range p.ProposalIDs {
			if pid == proposalID {
				return p, nil
			}
		}
	}
	return nil, nil
}

func (s *Service) LinkProposalToProject(ctx context.Context, spaceID, projectID, proposalID string) (*Project, error) {
	// Prevent a proposal from being linked to multiple projects.
	existing, err := s.GetProjectByProposalID(ctx, spaceID, proposalID)
	if err != nil {
		return nil, fmt.Errorf("checking existing project: %w", err)
	}
	if existing != nil && existing.ID != projectID {
		return nil, fmt.Errorf("proposal %s already has a project (%s)", proposalID, existing.ID)
	}

	p, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil {
		return nil, err
	}
	for _, id := range p.ProposalIDs {
		if id == proposalID {
			return p, nil // already linked to this project
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

	// Decision actions (votes) can only be completed during the voting process.
	// Meetings and discussions can be completed earlier as preparatory steps.
	if action.ActionType == ActionDecision {
		dp, err := s.GetDecisionPlan(ctx, spaceID, action.DecisionPlanID)
		if err != nil {
			return nil, fmt.Errorf("finding decision plan: %w", err)
		}
		if dp.ProposalID != "" {
			prop, err := s.GetProposal(ctx, spaceID, dp.ProposalID)
			if err != nil {
				return nil, fmt.Errorf("finding proposal: %w", err)
			}
			if prop.Status != ProposalVotingProcess {
				return nil, fmt.Errorf("voting is only allowed when the proposal is in voting process (current status: %s)", prop.Status)
			}
		}
	}

	action.Status = GovActionCompleted
	action.Outcome = outcome
	action.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, action.ID, "governance_action", action); err != nil {
		return nil, err
	}

	// If this was a decision action, check if all decisions are now complete
	if action.ActionType == ActionDecision {
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
	ImplementationPlanID string   `json:"implementation_plan_id"`
	Title                string   `json:"title"`
	Duration             string   `json:"duration"`
	ContributionIDs      []string `json:"contribution_ids,omitempty"`
}

func (s *Service) AddMilestone(ctx context.Context, spaceID string, req *CreateMilestoneRequest) (*Milestone, error) {
	ms := &Milestone{
		MilestoneID:          generateID("ms"),
		ImplementationPlanID: req.ImplementationPlanID,
		Title:                req.Title,
		Duration:             req.Duration,
		ContributionIDs:      req.ContributionIDs,
	}
	if err := s.store.Save(spaceID, ms.MilestoneID, "milestone", ms); err != nil {
		return nil, err
	}

	// Update the plan's milestones array so it's hydrated when fetched
	plan, err := s.GetImplementationPlan(ctx, spaceID, req.ImplementationPlanID)
	if err == nil {
		plan.Milestones = append(plan.Milestones, *ms)
		plan.UpdatedAt = time.Now()
		_ = s.store.Save(spaceID, plan.ID, "implementation_plan", plan)
	}

	return ms, nil
}

func (s *Service) GetMilestone(ctx context.Context, spaceID, msID string) (*Milestone, error) {
	var ms Milestone
	if err := s.store.Get(spaceID, msID, &ms); err != nil {
		return nil, err
	}
	return &ms, nil
}

// HydratePlan populates each milestone's Contributions field from ContributionIDs.
func (s *Service) HydratePlan(ctx context.Context, spaceID string, plan *ImplementationPlan) {
	for i := range plan.Milestones {
		ms := &plan.Milestones[i]
		ms.Contributions = nil
		for _, cid := range ms.ContributionIDs {
			c, err := s.GetContribution(ctx, spaceID, cid)
			if err == nil {
				ms.Contributions = append(ms.Contributions, c)
			}
		}
	}
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

	// Update parent's ChildContributionIDs if this is a sub-contribution
	if c.ParentContributionID != "" {
		parent, err := s.GetContribution(ctx, spaceID, c.ParentContributionID)
		if err == nil {
			parent.ChildContributionIDs = append(parent.ChildContributionIDs, c.ID)
			parent.UpdatedAt = now
			_ = s.store.Save(spaceID, parent.ID, "contribution", parent)
		}
	}

	// Update milestone's ContributionIDs and refresh the plan's inline milestones
	if c.MilestoneID != "" {
		ms, err := s.GetMilestone(ctx, spaceID, c.MilestoneID)
		if err == nil {
			ms.ContributionIDs = append(ms.ContributionIDs, c.ID)
			_ = s.store.Save(spaceID, ms.MilestoneID, "milestone", ms)

			// Refresh the plan's inline milestone copy
			if ms.ImplementationPlanID != "" {
				plan, planErr := s.GetImplementationPlan(ctx, spaceID, ms.ImplementationPlanID)
				if planErr == nil {
					for i := range plan.Milestones {
						if plan.Milestones[i].MilestoneID == ms.MilestoneID {
							plan.Milestones[i] = *ms
							break
						}
					}
					plan.UpdatedAt = now
					_ = s.store.Save(spaceID, plan.ID, "implementation_plan", plan)
				}
			}
		}
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
	if c.Status != ContribShared {
		return nil, fmt.Errorf("can only register interest on shared contributions, current status: %s", c.Status)
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
	if c.Status != ContribConfirmed && c.Status != ContribShared {
		return nil, fmt.Errorf("contribution must be confirmed or shared to assign, current: %s", c.Status)
	}
	c.AssignedContributorID = userID
	c.Status = ContribAssigned
	c.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, err
	}
	return c, nil
}

// SubmitEvidenceRequest carries evidence data for a contribution completion.
type SubmitEvidenceRequest struct {
	CompletionNotes string    `json:"completion_notes"`
	EvidenceURLs    []string  `json:"evidence_urls,omitempty"`
	AcceptanceNotes []string  `json:"acceptance_notes,omitempty"`
	ActualDuration  int       `json:"actual_duration,omitempty"`
	TimeReportFile  *FileRef  `json:"time_report_file,omitempty"`
	AttachmentFiles []FileRef `json:"attachment_files,omitempty"`
}

// ReviewRequest carries a review decision and supporting details.
type ReviewRequest struct {
	Decision      string `json:"decision"` // "approved", "incomplete", "declined"
	ReviewNotes   string `json:"review_notes"`
	QualityRating int    `json:"quality_rating,omitempty"`
}

// ConfirmContribution transitions a contribution:
//   - created → confirmed
//   - changed → assigned (re-confirmation after lead edit, contribution already has an assignee)
func (s *Service) ConfirmContribution(ctx context.Context, spaceID, contributionID string) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contributionID)
	if err != nil {
		return nil, fmt.Errorf("contribution not found: %w", err)
	}
	switch c.Status {
	case ContribCreated:
		if err := ValidateContributionTransition(c.Status, ContribConfirmed); err != nil {
			return nil, err
		}
		c.Status = ContribConfirmed
	case ContribChanged:
		if err := ValidateContributionTransition(c.Status, ContribAssigned); err != nil {
			return nil, err
		}
		c.Status = ContribAssigned
	default:
		return nil, fmt.Errorf("contribution must be in created or changed status to confirm, current: %s", c.Status)
	}
	c.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, fmt.Errorf("saving contribution: %w", err)
	}
	return c, nil
}

// ShareContribution transitions a confirmed contribution to shared, broadcasting it to eligible roles.
func (s *Service) ShareContribution(ctx context.Context, spaceID, contributionID string, sharedWithRoles []string) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contributionID)
	if err != nil {
		return nil, fmt.Errorf("contribution not found: %w", err)
	}
	if c.Status != ContribConfirmed {
		return nil, fmt.Errorf("contribution must be confirmed to share, current: %s", c.Status)
	}
	if err := ValidateContributionTransition(c.Status, ContribShared); err != nil {
		return nil, err
	}
	c.IsShared = true
	c.SharedWithRoles = sharedWithRoles
	c.Status = ContribShared
	c.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, fmt.Errorf("saving contribution: %w", err)
	}
	return c, nil
}

// OfferContribution transitions a confirmed contribution to offered, directing it at a specific user.
func (s *Service) OfferContribution(ctx context.Context, spaceID, contributionID, offeredTo, offeredToName string) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contributionID)
	if err != nil {
		return nil, fmt.Errorf("contribution not found: %w", err)
	}
	if c.Status != ContribConfirmed && c.Status != ContribShared {
		return nil, fmt.Errorf("contribution must be confirmed or shared to offer, current: %s", c.Status)
	}
	now := time.Now()
	c.OfferedTo = offeredTo
	c.OfferedToName = offeredToName
	c.OfferedAt = &now
	c.AssignedContributorName = offeredToName
	c.Status = ContribOffered
	c.UpdatedAt = now
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, fmt.Errorf("saving contribution: %w", err)
	}
	return c, nil
}

// AcceptOffer assigns a contribution to the accepting user.
// For offered contributions the userID must match OfferedTo.
// For shared contributions any interested user may accept.
func (s *Service) AcceptOffer(ctx context.Context, spaceID, contributionID, userID string) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contributionID)
	if err != nil {
		return nil, fmt.Errorf("contribution not found: %w", err)
	}
	switch c.Status {
	case ContribOffered:
		if c.OfferedTo != userID {
			return nil, fmt.Errorf("contribution is offered to %s, not %s", c.OfferedTo, userID)
		}
	case ContribShared:
		// Any user may accept a shared contribution
	default:
		return nil, fmt.Errorf("contribution must be offered or shared to accept, current: %s", c.Status)
	}
	if err := ValidateContributionTransition(c.Status, ContribAssigned); err != nil {
		return nil, err
	}
	c.AssignedContributorID = userID
	// Carry forward the offered-to name, or keep existing name
	if c.AssignedContributorName == "" && c.OfferedToName != "" {
		c.AssignedContributorName = c.OfferedToName
	}
	c.Status = ContribAssigned
	c.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, fmt.Errorf("saving contribution: %w", err)
	}
	return c, nil
}

// SubmitEvidence records evidence for an assigned contribution and transitions it to needs_review.
// All child contributions must be signed_off before the parent can submit evidence.
func (s *Service) SubmitEvidence(ctx context.Context, spaceID, contributionID string, req SubmitEvidenceRequest) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contributionID)
	if err != nil {
		return nil, fmt.Errorf("contribution not found: %w", err)
	}
	if c.Status != ContribAssigned {
		return nil, fmt.Errorf("contribution must be assigned to submit evidence, current: %s", c.Status)
	}

	// Verify all children are signed off
	if len(c.ChildContributionIDs) > 0 {
		var blocking []string
		for _, childID := range c.ChildContributionIDs {
			child, err := s.GetContribution(ctx, spaceID, childID)
			if err != nil {
				return nil, fmt.Errorf("failed to load child contribution %s: %w", childID, err)
			}
			if child.Status != ContribSignedOff && child.Status != ContribRewarded && child.Status != ContribArchived {
				blocking = append(blocking, childID)
			}
		}
		if len(blocking) > 0 {
			return nil, &BlockingChildrenError{IDs: blocking}
		}
	}

	if err := ValidateContributionTransition(c.Status, ContribNeedsReview); err != nil {
		return nil, err
	}
	c.CompletionNotes = req.CompletionNotes
	if req.EvidenceURLs != nil {
		c.EvidenceURLs = req.EvidenceURLs
	}
	if req.AcceptanceNotes != nil {
		c.AcceptanceNotes = req.AcceptanceNotes
	}
	if req.ActualDuration > 0 {
		c.ActualDuration = req.ActualDuration
	}
	if req.TimeReportFile != nil {
		c.TimeReportFile = req.TimeReportFile
	}
	if req.AttachmentFiles != nil {
		c.AttachmentFiles = req.AttachmentFiles
	}
	c.Status = ContribNeedsReview
	c.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, fmt.Errorf("saving contribution: %w", err)
	}
	return c, nil
}

// ReviewContribution records a review decision and transitions the contribution accordingly.
// decision must be one of "approved", "incomplete", or "declined".
func (s *Service) ReviewContribution(ctx context.Context, spaceID, contributionID string, req ReviewRequest) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contributionID)
	if err != nil {
		return nil, fmt.Errorf("contribution not found: %w", err)
	}
	if c.Status != ContribNeedsReview {
		return nil, fmt.Errorf("contribution must be in needs_review to review, current: %s", c.Status)
	}

	var newStatus ContributionStatus
	switch req.Decision {
	case "approved":
		newStatus = ContribApproved
	case "incomplete":
		newStatus = ContribIncomplete
	case "declined":
		newStatus = ContribDeclined
	default:
		return nil, fmt.Errorf("invalid review decision %q: must be approved, incomplete, or declined", req.Decision)
	}

	if err := ValidateContributionTransition(c.Status, newStatus); err != nil {
		return nil, err
	}

	now := time.Now()
	c.ReviewOutcome = req.Decision
	c.ReviewFeedback = req.ReviewNotes
	c.ReviewedAt = &now
	if req.QualityRating > 0 {
		c.QualityRating = req.QualityRating
	}
	c.Status = newStatus
	c.UpdatedAt = now
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, fmt.Errorf("saving contribution: %w", err)
	}
	return c, nil
}

// SignOffContribution transitions an approved contribution to signed_off.
func (s *Service) SignOffContribution(ctx context.Context, spaceID, contributionID, userID string) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contributionID)
	if err != nil {
		return nil, fmt.Errorf("contribution not found: %w", err)
	}
	if c.Status != ContribApproved {
		return nil, fmt.Errorf("contribution must be approved to sign off, current: %s", c.Status)
	}
	if err := ValidateContributionTransition(c.Status, ContribSignedOff); err != nil {
		return nil, err
	}
	now := time.Now()
	c.SignedOffBy = userID
	c.SignedOffAt = &now
	c.Status = ContribSignedOff
	c.UpdatedAt = now
	if err := s.store.Save(spaceID, c.ID, "contribution", c); err != nil {
		return nil, fmt.Errorf("saving contribution: %w", err)
	}
	return c, nil
}

// ApproveSubContribution approves a child contribution by assigning the parent's contributor and
// transitioning the child from created → assigned.
func (s *Service) ApproveSubContribution(ctx context.Context, spaceID, contributionID string) (*Contribution, error) {
	child, err := s.GetContribution(ctx, spaceID, contributionID)
	if err != nil {
		return nil, fmt.Errorf("contribution not found: %w", err)
	}
	if child.ParentContributionID == "" {
		return nil, fmt.Errorf("contribution %s is not a sub-contribution (no parent)", contributionID)
	}
	if child.Status != ContribCreated {
		return nil, fmt.Errorf("sub-contribution must be in created status to approve, current: %s", child.Status)
	}

	parent, err := s.GetContribution(ctx, spaceID, child.ParentContributionID)
	if err != nil {
		return nil, fmt.Errorf("parent contribution not found: %w", err)
	}

	// The sub-contribution inherits the parent's assigned contributor
	if parent.AssignedContributorID == "" {
		return nil, fmt.Errorf("parent contribution %s has no assigned contributor", parent.ID)
	}

	if err := ValidateContributionTransition(child.Status, ContribAssigned); err != nil {
		return nil, err
	}

	child.AssignedContributorID = parent.AssignedContributorID
	child.Status = ContribAssigned
	child.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, child.ID, "contribution", child); err != nil {
		return nil, fmt.Errorf("saving contribution: %w", err)
	}
	return child, nil
}

// SignOffPlan marks an implementation plan as signed off after validating all milestones and contributions.
func (s *Service) SignOffPlan(ctx context.Context, spaceID, planID, userID string) (*ImplementationPlan, error) {
	plan, err := s.GetImplementationPlan(ctx, spaceID, planID)
	if err != nil {
		return nil, fmt.Errorf("implementation plan not found: %w", err)
	}
	if plan.SignedOff {
		return nil, fmt.Errorf("plan is already signed off")
	}

	// Load all milestones for this plan
	rawMilestones, err := s.store.List(spaceID, "milestone")
	if err != nil {
		return nil, fmt.Errorf("loading milestones: %w", err)
	}
	var milestones []Milestone
	for _, r := range rawMilestones {
		var m Milestone
		if err := json.Unmarshal(r, &m); err == nil && m.ImplementationPlanID == planID {
			milestones = append(milestones, m)
		}
	}

	// Collect all contribution IDs referenced by milestones
	contribIDSet := map[string]struct{}{}
	for _, m := range milestones {
		for _, cid := range m.ContributionIDs {
			contribIDSet[cid] = struct{}{}
		}
	}

	// Load all referenced contributions
	var planContribs []Contribution
	for cid := range contribIDSet {
		c, err := s.GetContribution(ctx, spaceID, cid)
		if err != nil {
			return nil, fmt.Errorf("loading contribution %s: %w", cid, err)
		}
		planContribs = append(planContribs, *c)
	}

	if err := ValidatePlanSignOff(plan, milestones, planContribs); err != nil {
		return nil, err
	}

	now := time.Now()
	plan.SignedOff = true
	plan.SignedOffBy = userID
	plan.SignedOffAt = &now
	plan.CurrentStatus = "active"
	plan.UpdatedAt = now
	if err := s.store.Save(spaceID, plan.ID, "implementation_plan", plan); err != nil {
		return nil, fmt.Errorf("saving plan: %w", err)
	}
	return plan, nil
}

// ListContributionsByProject returns all contributions that belong to the given project.
func (s *Service) ListContributionsByProject(ctx context.Context, spaceID, projectID string) ([]*Contribution, error) {
	all, err := s.ListContributions(ctx, spaceID)
	if err != nil {
		return nil, err
	}
	var result []*Contribution
	for _, c := range all {
		if c.ProjectID == projectID {
			result = append(result, c)
		}
	}
	return result, nil
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
