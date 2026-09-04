package contributions

import (
	"encoding/json"
	"time"
)

// FileRef represents a file attachment stored via the files service.
type FileRef struct {
	FileRef     string `json:"file_ref"`
	FileName    string `json:"file_name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size,omitempty"`
	Category    string `json:"category"`
	UploadedBy  string `json:"uploaded_by"`
	UploadedAt  string `json:"uploaded_at"`
}

// InterestedContributor records a user who has registered interest in a shared contribution.
type InterestedContributor struct {
	UserID       string `json:"user_id"`
	UserName     string `json:"user_name"`
	RegisteredAt string `json:"registered_at"`
	InterestNote string `json:"interest_note"`
}

// --- Proposal ---

// ProposalStatus represents the lifecycle state of a proposal.
type ProposalStatus string

// ProposalDraft and the other ProposalStatus values enumerate the stages a
// proposal moves through from creation to completion or withdrawal.
const (
	ProposalDraft         ProposalStatus = "draft"
	ProposalSubmitted     ProposalStatus = "submitted"
	ProposalEndorsing     ProposalStatus = "endorsing"
	ProposalInReview      ProposalStatus = "in_review"
	ProposalSignedOff     ProposalStatus = "signed_off"
	ProposalVotingProcess ProposalStatus = "voting_process"
	ProposalApproved      ProposalStatus = "approved"
	ProposalRejected      ProposalStatus = "rejected"
	ProposalCompleted     ProposalStatus = "completed"
	ProposalWithdrawn     ProposalStatus = "withdrawn"
)

// ProposalType categorizes the kind of work or change a proposal describes.
type ProposalType string

// ProposalTypeTechnical and the other ProposalType values enumerate the
// categories a proposal can be tagged with.
const (
	ProposalTypeTechnical  ProposalType = "technical"
	ProposalTypeCommunity  ProposalType = "community"
	ProposalTypeGovernance ProposalType = "governance"
	ProposalTypeOperations ProposalType = "operations"
)

// Priority indicates the urgency of a proposal or contribution.
type Priority string

// PriorityLow and the other Priority values enumerate the supported urgency
// levels, from low to critical.
const (
	PriorityLow      Priority = "low"
	PriorityMedium   Priority = "medium"
	PriorityHigh     Priority = "high"
	PriorityCritical Priority = "critical"
)

// Proposal is a community-submitted plan for work, funding, or governance
// action that moves through endorsement, review, and sign-off.
type Proposal struct {
	ID                    string            `json:"id"`
	ProposerID            string            `json:"proposer_id"`
	Title                 string            `json:"title"`
	Types                 []ProposalType    `json:"type"`
	Priority              Priority          `json:"priority"`
	Description           string            `json:"description"`
	ProblemStatement      string            `json:"problem_statement"`
	Solution              string            `json:"solution"`
	ExpectedOutcomes      []string          `json:"expected_outcomes"`
	EstimatedBudget       string            `json:"estimated_budget"`
	Timeline              string            `json:"timeline"`
	ProjectPlan           []ProjectPlanItem `json:"project_plan,omitempty"`
	Status                ProposalStatus    `json:"status"`
	CreatedAt             time.Time         `json:"created_at"`
	UpdatedAt             time.Time         `json:"updated_at"`
	ProposalLeadID        string            `json:"proposal_lead_id,omitempty"`
	ProposalStewardID     string            `json:"proposal_steward_id,omitempty"`
	EndorsementThreshold  int               `json:"endorsement_threshold"`
	LeadContributionID    string            `json:"lead_contribution_id,omitempty"`
	StewardContributionID string            `json:"steward_contribution_id,omitempty"`
	Attachments           []Attachment      `json:"attachments,omitempty"`
	// Data holds org-defined custom fields declared in the Proposal schema but
	// not modelled as typed struct fields above. It lets an org extend the
	// descriptive body without a backend change; unknown-but-schema-defined
	// fields round-trip through create/update/read unchanged.
	Data map[string]interface{} `json:"data,omitempty"`
}

// SchemaMap flattens a proposal into the field→value map used for schema
// validation and filtering. Typed core/body fields appear under their JSON
// names and custom fields from Data are merged in at the top level, so a single
// map can be validated against, or matched by, the Proposal TypeDefinition.
func (p *Proposal) SchemaMap() map[string]interface{} {
	raw, err := json.Marshal(p)
	if err != nil {
		return nil
	}
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	delete(m, "data")
	for k, v := range p.Data {
		m[k] = v
	}
	return m
}

// ProjectPlanItem is a single step in a proposal's high-level project plan.
type ProjectPlanItem struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Duration    string `json:"duration"`
}

// Attachment is a named link attached to a proposal.
type Attachment struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// ProposalHistoryEntry records a single change made to a proposal, for the
// audit trail shown alongside a proposal's detail view.
type ProposalHistoryEntry struct {
	ID         string        `json:"id"`
	ProposalID string        `json:"proposal_id"`
	UserID     string        `json:"user_id"`
	Action     string        `json:"action"`
	Changes    []FieldChange `json:"changes,omitempty"`
	CreatedAt  time.Time     `json:"created_at"`
}

// FieldChange records the before/after values of a single field in a
// ProposalHistoryEntry.
type FieldChange struct {
	Field    string `json:"field"`
	OldValue string `json:"old_value"`
	NewValue string `json:"new_value"`
}

// --- Endorsement ---

// Endorsement records a community member's support for a proposal.
type Endorsement struct {
	ProposalID string    `json:"proposal_id"`
	EndorserID string    `json:"endorser_id"`
	EndorsedAt time.Time `json:"endorsed_at"`
	Comment    string    `json:"comment,omitempty"`
}

// --- Project ---

// ProjectStatus represents the lifecycle state of a project.
type ProjectStatus string

// ProjectCreated and the other ProjectStatus values enumerate the stages a
// project moves through from creation to completion or archival.
const (
	ProjectCreated           ProjectStatus = "created"
	ProjectActive            ProjectStatus = "active"
	ProjectPendingCompletion ProjectStatus = "pending_completion"
	ProjectCompleted         ProjectStatus = "completed"
	ProjectArchived          ProjectStatus = "archived"
)

// ProjectImageType categorizes an image attached to a project.
type ProjectImageType string

// ImageLogo and the other ProjectImageType values enumerate the supported
// image roles for a project's media gallery.
const (
	ImageLogo       ProjectImageType = "logo"
	ImageBanner     ProjectImageType = "banner"
	ImageScreenshot ProjectImageType = "screenshot"
	ImageOther      ProjectImageType = "other"
)

// ProjectImage is a single image in a project's media gallery.
type ProjectImage struct {
	ImageID    string           `json:"image_id"`
	URL        string           `json:"url"`
	Type       ProjectImageType `json:"type"`
	AltText    string           `json:"alt_text,omitempty"`
	UploadedAt time.Time        `json:"uploaded_at"`
	UploadedBy string           `json:"uploaded_by"`
}

// Project is a body of work that groups one or more proposals, an
// implementation plan, milestones, and contributions.
type Project struct {
	ID                    string         `json:"id"`
	Title                 string         `json:"title"`
	Description           string         `json:"description"`
	Status                ProjectStatus  `json:"status"`
	Images                []ProjectImage `json:"images,omitempty"`
	Budget                string         `json:"budget,omitempty"`
	Duration              string         `json:"duration,omitempty"`
	StartDate             string         `json:"start_date,omitempty"`
	EndDate               string         `json:"end_date,omitempty"`
	ProposalIDs           []string       `json:"proposal_ids,omitempty"`
	ImplementationPlanIDs []string       `json:"implementation_plan_ids,omitempty"`
	ProjectStewardID      string         `json:"project_steward_id,omitempty"`
	ProjectLeadID         string         `json:"project_lead_id,omitempty"`
	CreatedBy             string         `json:"created_by"`
	CreatedAt             time.Time      `json:"created_at"`
	UpdatedAt             time.Time      `json:"updated_at"`
	SubmittedBy           string         `json:"submitted_by,omitempty"`
	CompletedBy           string         `json:"completed_by,omitempty"`
	CompletedAt           *time.Time     `json:"completed_at,omitempty"`
	RejectionReason       string         `json:"rejection_reason,omitempty"`
	CommentCount          int            `json:"comment_count,omitempty"`

	// Proof is a KERI-anchored proof envelope for the completion approval
	// (issue #20). Persisted verbatim; verification is deferred to issue #19.
	Proof *Proof `json:"proof,omitempty"`
}

// --- Decision Plan ---

// DecisionPlanStatus represents the lifecycle state of a decision plan.
type DecisionPlanStatus string

// DecisionPlanDrafted and the other DecisionPlanStatus values enumerate the
// stages a decision plan moves through from drafting to sign-off.
const (
	DecisionPlanDrafted   DecisionPlanStatus = "drafted"
	DecisionPlanSubmitted DecisionPlanStatus = "submitted"
	DecisionPlanSignedOff DecisionPlanStatus = "signed_off"
)

// DecisionPlan groups the governance actions (discussions, meetings, votes)
// that a proposal must pass through to reach sign-off.
type DecisionPlan struct {
	ID                string             `json:"id"`
	ProposalID        string             `json:"proposal_id"`
	Title             string             `json:"title"`
	Description       string             `json:"description"`
	Status            DecisionPlanStatus `json:"status"`
	Objectives        []string           `json:"objectives"`
	ExpectedOutcomes  []string           `json:"expected_outcomes"`
	GovernanceActions []GovernanceAction `json:"governance_actions"`
	ProposalLeadID    string             `json:"proposal_lead_id"`
	ProposalStewardID string             `json:"proposal_steward_id"`
	CreatedAt         time.Time          `json:"created_at"`
	UpdatedAt         time.Time          `json:"updated_at"`

	// Proof is a KERI-anchored proof envelope for the sign-off transition
	// (issue #20). Persisted verbatim; verification is deferred to issue #19.
	Proof *Proof `json:"proof,omitempty"`
}

// --- Governance Action ---

// GovernanceActionStatus represents the lifecycle state of a governance action.
type GovernanceActionStatus string

// GovActionPlanned and the other GovernanceActionStatus values enumerate the
// stages a governance action moves through from planning to completion or
// archival.
const (
	GovActionPlanned   GovernanceActionStatus = "planned"
	GovActionCompleted GovernanceActionStatus = "completed"
	GovActionArchived  GovernanceActionStatus = "archived"
)

// HouseType identifies which governance house a GovernanceAction belongs to.
type HouseType string

// HouseElderCouncil and the other HouseType values enumerate the recognized
// governance houses.
const (
	HouseElderCouncil  HouseType = "elders_council"
	HouseCommunityReps HouseType = "community_reps"
	HouseContributors  HouseType = "contributors"
)

// ActionType categorizes a GovernanceAction.
type ActionType string

// ActionDiscussion and the other ActionType values enumerate the supported
// governance action kinds.
const (
	ActionDiscussion ActionType = "discussion"
	ActionDecision   ActionType = "decision"
	ActionMeeting    ActionType = "meeting"
)

// OutcomeType represents the result of a vote or decision.
type OutcomeType string

// OutcomeNoVeto and the other OutcomeType values enumerate the possible
// outcomes of a governance vote or decision.
const (
	OutcomeNoVeto   OutcomeType = "no_veto"
	OutcomeVeto     OutcomeType = "veto"
	OutcomeApproved OutcomeType = "approved"
	OutcomeRejected OutcomeType = "rejected"
)

// GovernanceAction is a discussion, meeting, or vote within a decision plan.
type GovernanceAction struct {
	ID              string                 `json:"id"`
	DecisionPlanID  string                 `json:"decision_plan_id"`
	House           HouseType              `json:"house"`
	ActionType      ActionType             `json:"action_type"`
	Title           string                 `json:"title"`
	Description     string                 `json:"description"`
	MeetingDate     string                 `json:"meeting_date,omitempty"`
	MeetingTime     string                 `json:"meeting_time,omitempty"`
	MeetingLocation string                 `json:"meeting_location,omitempty"`
	LinkedActionID  string                 `json:"linked_action_id,omitempty"`
	VotingEndDate   string                 `json:"voting_end_date,omitempty"`
	VotingEndTime   string                 `json:"voting_end_time,omitempty"`
	Status          GovernanceActionStatus `json:"status"`
	Outcome         OutcomeType            `json:"outcome,omitempty"`
	Votes           []Vote                 `json:"votes,omitempty"`
	CompletionNotes string                 `json:"completion_notes,omitempty"`
	CompletionFiles []FileRef              `json:"completion_files,omitempty"`
	CompletionLinks []string               `json:"completion_links,omitempty"`
	CompletedBy     string                 `json:"completed_by,omitempty"`
	CreatedAt       time.Time              `json:"created_at"`
	UpdatedAt       time.Time              `json:"updated_at"`
}

// Vote records a single participant's decision on a governance action.
type Vote struct {
	VoterID   string      `json:"voter_id"`
	VoterName string      `json:"voter_name"`
	Decision  OutcomeType `json:"decision"`
	Comment   string      `json:"comment,omitempty"`
	VotedAt   time.Time   `json:"voted_at"`
}

// --- Contribution Comments ---

// ContributionComment is a user comment on a contribution.
type ContributionComment struct {
	ID             string    `json:"id"`
	ContributionID string    `json:"contribution_id"`
	UserID         string    `json:"user_id"`
	UserName       string    `json:"user_name"`
	Text           string    `json:"text"`
	CreatedAt      time.Time `json:"created_at"`
}

// --- Project Comments ---

// ProjectComment is a user comment on a project.
type ProjectComment struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	UserID    string    `json:"user_id"`
	UserName  string    `json:"user_name"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"created_at"`
}

// --- Proposal Comments ---

// ProposalComment is a user comment on a proposal. It may also represent a
// synthesized event (endorsement, completion, or vote) surfaced in the same
// comment feed; see the Kind field.
type ProposalComment struct {
	ID         string    `json:"id"`
	ProposalID string    `json:"proposal_id"`
	UserID     string    `json:"user_id"`
	UserName   string    `json:"user_name"`
	Text       string    `json:"text"`
	CreatedAt  time.Time `json:"created_at"`

	// Synthesized fields (omitempty). Plain user comments leave these unset.
	Kind        string    `json:"kind,omitempty"`     // user | endorsement | completion | vote
	Subtitle    string    `json:"subtitle,omitempty"` // e.g. "Endorsed proposal" or "Voted Approved"
	Outcome     string    `json:"outcome,omitempty"`  // for vote/completion: approved | rejected | no_veto | veto
	Attachments []FileRef `json:"attachments,omitempty"`
	Links       []string  `json:"links,omitempty"`
}

// --- Implementation Plan ---

// PlanStatus represents the lifecycle state of an implementation plan.
type PlanStatus string

// PlanDraft and the other PlanStatus values enumerate the stages an
// implementation plan moves through from drafting to archival.
const (
	PlanDraft    PlanStatus = "draft"
	PlanActive   PlanStatus = "active"
	PlanArchived PlanStatus = "archived"
)

// ImplementationPlan is the budget, milestones, and sign-off state for
// carrying out a project.
type ImplementationPlan struct {
	ID               string      `json:"id"`
	ProjectID        string      `json:"project_id"`
	TotalBudget      string      `json:"total_budget"`
	Milestones       []Milestone `json:"milestones"`
	ProjectLeadID    string      `json:"project_lead"`
	ProjectStewardID string      `json:"project_steward_id"`
	CurrentStatus    string      `json:"current_status"`
	CreatedAt        time.Time   `json:"created_at"`
	UpdatedAt        time.Time   `json:"updated_at"`

	// Plan lifecycle
	Version     string     `json:"version,omitempty"`
	Status      PlanStatus `json:"status,omitempty"`
	SignedOff   bool       `json:"signed_off"`
	SignedOffBy string     `json:"signed_off_by,omitempty"`
	SignedOffAt *time.Time `json:"signed_off_at,omitempty"`
	CreatedBy   string     `json:"created_by,omitempty"`

	// Proof is a KERI-anchored proof envelope for the sign-off action
	// (issue #20). Persisted verbatim; verification is deferred to issue #19.
	Proof *Proof `json:"proof,omitempty"`

	// ChangeLog records what has changed since the last sign-off, in
	// chronological order. It is cleared whenever the plan is signed off
	// (SignOffPlan) and accumulates entries again as subsequent mutations
	// invalidate the sign-off. Capped at maxPlanChangeLogEntries.
	ChangeLog []PlanChangeEntry `json:"change_log,omitempty"`
}

// PlanChangeEntry records a single change made to an implementation plan
// (or one of its milestones/contributions) since the plan was last signed off.
type PlanChangeEntry struct {
	ID                string `json:"id"`
	Kind              string `json:"kind"` // milestone_edited|milestone_added|milestone_archived|contribution_added|contribution_edited|contribution_removed
	MilestoneID       string `json:"milestone_id,omitempty"`
	MilestoneTitle    string `json:"milestone_title,omitempty"`
	ContributionID    string `json:"contribution_id,omitempty"`
	ContributionTitle string `json:"contribution_title,omitempty"`
	// Parent refs are set when the change concerns a sub-contribution, so the
	// UI can nest it under its parent within the milestone group. MilestoneID/
	// MilestoneTitle are then resolved via the parent chain (subs carry no
	// milestone_id of their own).
	ParentContributionID    string        `json:"parent_contribution_id,omitempty"`
	ParentContributionTitle string        `json:"parent_contribution_title,omitempty"`
	Changes                 []FieldChange `json:"changes,omitempty"`
	ChangedBy               string        `json:"changed_by"`
	ChangedAt               time.Time     `json:"changed_at"`
}

// --- Milestone ---

// MilestoneStatus represents the lifecycle state of a milestone.
type MilestoneStatus string

// MilestonePlanned and the other MilestoneStatus values enumerate the stages
// a milestone moves through from planning to completion or archival.
const (
	MilestonePlanned    MilestoneStatus = "planned"
	MilestoneInProgress MilestoneStatus = "in_progress"
	MilestoneCompleted  MilestoneStatus = "completed"
	MilestoneDelayed    MilestoneStatus = "delayed"
	MilestoneArchived   MilestoneStatus = "archived"
)

// Milestone is a phase of an implementation plan grouping related
// contributions.
type Milestone struct {
	MilestoneID          string   `json:"milestone_id"`
	ImplementationPlanID string   `json:"implementation_plan_id"`
	Title                string   `json:"title"`
	Duration             string   `json:"duration"`
	ContributionIDs      []string `json:"contribution_ids,omitempty"`

	// Extended milestone fields
	ProjectID        string          `json:"project_id,omitempty"`
	Description      string          `json:"description,omitempty"`
	StartDate        string          `json:"start_date,omitempty"`
	EndDate          string          `json:"end_date,omitempty"`
	Status           MilestoneStatus `json:"status,omitempty"`
	SuccessCriteria  []string        `json:"success_criteria,omitempty"`
	Dependencies     []string        `json:"dependencies,omitempty"`
	BudgetAllocation float64         `json:"budget_allocation,omitempty"`
	ActualCost       float64         `json:"actual_cost,omitempty"`

	// Hydrated contributions — populated at read time, not stored
	Contributions []*Contribution `json:"contributions,omitempty"`
}

// --- Contribution ---

// ContributionStatus represents the lifecycle state of a contribution.
type ContributionStatus string

// ContribCreated and the other ContributionStatus values enumerate the
// stages a contribution moves through from creation to reward or archival.
const (
	ContribCreated     ContributionStatus = "created"
	ContribConfirmed   ContributionStatus = "confirmed"
	ContribShared      ContributionStatus = "shared"
	ContribOffered     ContributionStatus = "offered"
	ContribAssigned    ContributionStatus = "assigned"
	ContribChanged     ContributionStatus = "changed"
	ContribNeedsReview ContributionStatus = "needs_review"
	ContribApproved    ContributionStatus = "approved"
	ContribIncomplete  ContributionStatus = "incomplete"
	ContribDeclined    ContributionStatus = "declined"
	ContribSignedOff   ContributionStatus = "signed_off"
	ContribRewarded    ContributionStatus = "rewarded"
	ContribArchived    ContributionStatus = "archived"
)

// Contribution is a unit of work within a project, tracked from creation
// through assignment, review, sign-off, and reward.
type Contribution struct {
	ID                     string             `json:"id"`
	ProjectID              string             `json:"project_id"`
	ContributionType       ProposalType       `json:"contribution_type"`
	Priority               Priority           `json:"priority"`
	EstimatedDuration      int                `json:"estimated_duration"`
	ActualDuration         float64            `json:"actual_duration,omitempty"`
	Budget                 string             `json:"budget,omitempty"`
	ActualCost             float64            `json:"actual_cost,omitempty"`
	Deadline               *time.Time         `json:"deadline,omitempty"`
	CreatedAt              time.Time          `json:"created_at"`
	CreatedBy              string             `json:"created_by"`
	UpdatedAt              time.Time          `json:"updated_at"`
	Status                 ContributionStatus `json:"status"`
	MilestoneID            string             `json:"milestone_id,omitempty"`
	BlockedReason          string             `json:"blocked_reason,omitempty"`
	Title                  string             `json:"title"`
	Description            string             `json:"description"`
	Objectives             []string           `json:"objectives"`
	Deliverables           []string           `json:"deliverables"`
	AcceptanceCriteria     []string           `json:"acceptance_criteria"`
	SkillRequirements      []string           `json:"skill_requirements"`
	Tags                   []string           `json:"tags,omitempty"`
	RelatedContributions   []string           `json:"related_contributions,omitempty"`
	DependentContributions []string           `json:"dependent_contributions,omitempty"`
	BlockedBy              []string           `json:"blocked_by,omitempty"`
	EligibleRoles          []string           `json:"eligible_roles,omitempty"`
	Version                string             `json:"version,omitempty"`
	TimeReport             string             `json:"time_report,omitempty"`
	ParentContributionID   string             `json:"parent_contribution,omitempty"`
	ChildContributionIDs   []string           `json:"child_contributions,omitempty"`
	AssignedContributorID  string             `json:"assigned_contributor,omitempty"`
	ReviewerID             string             `json:"contribution_reviewer,omitempty"`
	Reviewers              []string           `json:"reviewers,omitempty"`
	EvidenceSubmitted      []string           `json:"evidence_submitted,omitempty"`
	CompletionNotes        string             `json:"completion_notes,omitempty"`
	ReviewOutcome          string             `json:"review_outcome,omitempty"`
	ReviewFeedback         string             `json:"review_feedback,omitempty"`
	ReviewedBy             string             `json:"reviewed_by,omitempty"`
	ReviewedAt             *time.Time         `json:"reviewed_at,omitempty"`
	QualityRating          int                `json:"quality_rating,omitempty"`
	SignedOffBy            string             `json:"signed_off_by,omitempty"`
	SignedOffAt            *time.Time         `json:"signed_off_at,omitempty"`
	// EvidenceEditedAt records the last time the assigned contributor edited
	// their submitted evidence (contributor self-edit before sign-off).
	EvidenceEditedAt *time.Time `json:"evidence_edited_at,omitempty"`
	RewardedBy       string     `json:"rewarded_by,omitempty"`
	RewardedAt       *time.Time `json:"rewarded_at,omitempty"`

	// KERI-anchored proof envelopes (issue #20), one per proof-bearing
	// transition so a later reward can never destroy the sign-off proof —
	// #19's verifier needs both to hold simultaneously. Persisted verbatim;
	// verification is deferred to issue #19.
	SignOffProof *Proof `json:"sign_off_proof,omitempty"`
	RewardProof  *Proof `json:"reward_proof,omitempty"`

	// Sharing & offering
	IsShared        bool       `json:"is_shared,omitempty"`
	SharedWithRoles []string   `json:"shared_with_roles,omitempty"`
	ShareLink       string     `json:"share_link,omitempty"`
	OfferedTo       string     `json:"offered_to,omitempty"`
	OfferedToName   string     `json:"offered_to_name,omitempty"`
	OfferedAt       *time.Time `json:"offered_at,omitempty"`

	// Interest registration
	InterestedContributors []InterestedContributor `json:"interested_contributors,omitempty"`

	// Contributor name denormalisation
	AssignedContributorName string `json:"assigned_contributor_name,omitempty"`

	// Change tracking (populated when status is "changed")
	ChangeReason string             `json:"change_reason,omitempty"`
	ChangedBy    string             `json:"changed_by,omitempty"`
	ChangedAt    *time.Time         `json:"changed_at,omitempty"`
	ChangesDiff  []ContributionDiff `json:"changes_diff,omitempty"`

	// Evidence & completion (extended)
	AcceptanceNotes []string  `json:"acceptance_notes,omitempty"`
	EvidenceURLs    []string  `json:"evidence_urls,omitempty"`
	EvidenceFiles   []FileRef `json:"evidence_files,omitempty"`
	TimeReportFile  *FileRef  `json:"time_report_file,omitempty"`
	AttachmentFiles []FileRef `json:"attachment_files,omitempty"`

	CommentCount int `json:"comment_count,omitempty"`
}

// ContributionDiff records a single field change for change tracking.
type ContributionDiff struct {
	Field    string `json:"field"`
	OldValue string `json:"old_value"`
	NewValue string `json:"new_value"`
}

// --- Contribution Registration ---

// ContributionRegistration represents a contributor's interest in a contribution.
type ContributionRegistration struct {
	ID             string    `json:"id"`
	ContributionID string    `json:"contribution_id"`
	UserID         string    `json:"user_id"`
	Statement      string    `json:"statement"`
	RegisteredAt   time.Time `json:"registered_at"`
}
