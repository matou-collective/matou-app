// backend/internal/contributions/models.go
package contributions

import "time"

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

type ProposalStatus string

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
)

type ProposalType string

const (
	ProposalTypeTechnical  ProposalType = "technical"
	ProposalTypeCommunity  ProposalType = "community"
	ProposalTypeGovernance ProposalType = "governance"
	ProposalTypeOperations ProposalType = "operations"
)

type Priority string

const (
	PriorityLow      Priority = "low"
	PriorityMedium   Priority = "medium"
	PriorityHigh     Priority = "high"
	PriorityCritical Priority = "critical"
)

type Proposal struct {
	ID               string            `json:"id"`
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
	ProjectPlan      []ProjectPlanItem `json:"project_plan,omitempty"`
	Status                ProposalStatus    `json:"status"`
	CreatedAt             time.Time         `json:"created_at"`
	UpdatedAt             time.Time         `json:"updated_at"`
	ProposalLeadID        string            `json:"proposal_lead_id,omitempty"`
	ProposalStewardID     string            `json:"proposal_steward_id,omitempty"`
	EndorsementThreshold  int               `json:"endorsement_threshold"`
	LeadContributionID    string            `json:"lead_contribution_id,omitempty"`
	StewardContributionID string            `json:"steward_contribution_id,omitempty"`
	Attachments           []Attachment      `json:"attachments,omitempty"`
}

type ProjectPlanItem struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Duration    string `json:"duration"`
}

type Attachment struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type ProposalHistoryEntry struct {
	ID         string        `json:"id"`
	ProposalID string        `json:"proposal_id"`
	UserID     string        `json:"user_id"`
	Action     string        `json:"action"`
	Changes    []FieldChange `json:"changes,omitempty"`
	CreatedAt  time.Time     `json:"created_at"`
}

type FieldChange struct {
	Field    string `json:"field"`
	OldValue string `json:"old_value"`
	NewValue string `json:"new_value"`
}

// --- Endorsement ---

type Endorsement struct {
	EndorserID string    `json:"endorser_id"`
	EndorsedAt time.Time `json:"endorsed_at"`
	Comment    string    `json:"comment,omitempty"`
}

// --- Project ---

type ProjectStatus string

const (
	ProjectCreated   ProjectStatus = "created"
	ProjectActive    ProjectStatus = "active"
	ProjectCompleted ProjectStatus = "completed"
	ProjectArchived  ProjectStatus = "archived"
)

type ProjectImageType string

const (
	ImageLogo       ProjectImageType = "logo"
	ImageBanner     ProjectImageType = "banner"
	ImageScreenshot ProjectImageType = "screenshot"
	ImageOther      ProjectImageType = "other"
)

type ProjectImage struct {
	ImageID    string           `json:"image_id"`
	URL        string           `json:"url"`
	Type       ProjectImageType `json:"type"`
	AltText    string           `json:"alt_text,omitempty"`
	UploadedAt time.Time        `json:"uploaded_at"`
	UploadedBy string           `json:"uploaded_by"`
}

type Project struct {
	ID                    string         `json:"id"`
	Title                 string         `json:"title"`
	Description           string         `json:"description"`
	Status                ProjectStatus  `json:"status"`
	Images                []ProjectImage `json:"images,omitempty"`
	ProposalIDs           []string       `json:"proposal_ids,omitempty"`
	ImplementationPlanIDs []string       `json:"implementation_plan_ids,omitempty"`
	ProjectStewardID      string         `json:"project_steward_id,omitempty"`
	ProjectLeadID         string         `json:"project_lead_id,omitempty"`
	CreatedBy             string         `json:"created_by"`
	CreatedAt             time.Time      `json:"created_at"`
	UpdatedAt             time.Time      `json:"updated_at"`
}

// --- Decision Plan ---

type DecisionPlanStatus string

const (
	DecisionPlanDrafted   DecisionPlanStatus = "drafted"
	DecisionPlanSubmitted DecisionPlanStatus = "submitted"
	DecisionPlanSignedOff DecisionPlanStatus = "signed_off"
)

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
}

// --- Governance Action ---

type GovernanceActionStatus string

const (
	GovActionPlanned   GovernanceActionStatus = "planned"
	GovActionCompleted GovernanceActionStatus = "completed"
	GovActionArchived  GovernanceActionStatus = "archived"
)

type HouseType string

const (
	HouseElderCouncil  HouseType = "elders_council"
	HouseCommunityReps HouseType = "community_reps"
	HouseContributors  HouseType = "contributors"
)

type ActionType string

const (
	ActionDiscussion ActionType = "discussion"
	ActionDecision   ActionType = "decision"
	ActionMeeting    ActionType = "meeting"
)

type OutcomeType string

const (
	OutcomeNoVeto   OutcomeType = "no_veto"
	OutcomeVeto     OutcomeType = "veto"
	OutcomeApproved OutcomeType = "approved"
	OutcomeRejected OutcomeType = "rejected"
)

type GovernanceAction struct {
	ID              string                 `json:"id"`
	DecisionPlanID  string                 `json:"decision_plan_id"`
	House           HouseType              `json:"house"`
	ActionType      ActionType             `json:"action_type"`
	Description     string                 `json:"description"`
	MeetingDate     string                 `json:"meeting_date,omitempty"`
	MeetingTime     string                 `json:"meeting_time,omitempty"`
	MeetingLocation string                 `json:"meeting_location,omitempty"`
	LinkedActionID  string                 `json:"linked_action_id,omitempty"`
	Status          GovernanceActionStatus `json:"status"`
	Outcome         OutcomeType            `json:"outcome,omitempty"`
	VoteData        map[string]interface{} `json:"vote_data,omitempty"`
	CreatedAt       time.Time              `json:"created_at"`
	UpdatedAt       time.Time              `json:"updated_at"`
}

// --- Proposal Comments ---

type ProposalComment struct {
	ID         string    `json:"id"`
	ProposalID string    `json:"proposal_id"`
	UserID     string    `json:"user_id"`
	UserName   string    `json:"user_name"`
	Text       string    `json:"text"`
	CreatedAt  time.Time `json:"created_at"`
}

// --- Implementation Plan ---

// PlanStatus represents the lifecycle state of an implementation plan.
type PlanStatus string

const (
	PlanDraft    PlanStatus = "draft"
	PlanActive   PlanStatus = "active"
	PlanArchived PlanStatus = "archived"
)

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
}

// --- Milestone ---

// MilestoneStatus represents the lifecycle state of a milestone.
type MilestoneStatus string

const (
	MilestonePlanned    MilestoneStatus = "planned"
	MilestoneInProgress MilestoneStatus = "in_progress"
	MilestoneCompleted  MilestoneStatus = "completed"
	MilestoneDelayed    MilestoneStatus = "delayed"
)

type Milestone struct {
	MilestoneID          string   `json:"milestone_id"`
	ImplementationPlanID string   `json:"implementation_plan_id"`
	Title                string   `json:"title"`
	Duration             string   `json:"duration"`
	ContributionIDs      []string `json:"contribution_ids,omitempty"`

	// Extended milestone fields
	ProjectID          string          `json:"project_id,omitempty"`
	Description        string          `json:"description,omitempty"`
	StartDate          string          `json:"start_date,omitempty"`
	EndDate            string          `json:"end_date,omitempty"`
	Status             MilestoneStatus `json:"status,omitempty"`
	SuccessCriteria    []string        `json:"success_criteria,omitempty"`
	Dependencies       []string        `json:"dependencies,omitempty"`
	BudgetAllocation   float64         `json:"budget_allocation,omitempty"`
	ActualCost         float64         `json:"actual_cost,omitempty"`

	// Hydrated contributions — populated at read time, not stored
	Contributions []*Contribution `json:"contributions,omitempty"`
}

// --- Contribution ---

type ContributionStatus string

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

type Contribution struct {
	ID                     string             `json:"id"`
	ProjectID              string             `json:"project_id"`
	ContributionType       ProposalType       `json:"contribution_type"`
	Priority               Priority           `json:"priority"`
	EstimatedDuration      int                `json:"estimated_duration"`
	ActualDuration         int                `json:"actual_duration,omitempty"`
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

	// Sharing & offering
	IsShared              bool                    `json:"is_shared,omitempty"`
	SharedWithRoles       []string                `json:"shared_with_roles,omitempty"`
	ShareLink             string                  `json:"share_link,omitempty"`
	OfferedTo             string                  `json:"offered_to,omitempty"`
	OfferedToName         string                  `json:"offered_to_name,omitempty"`
	OfferedAt             *time.Time              `json:"offered_at,omitempty"`

	// Interest registration
	InterestedContributors []InterestedContributor `json:"interested_contributors,omitempty"`

	// Contributor name denormalisation
	AssignedContributorName string `json:"assigned_contributor_name,omitempty"`

	// Change tracking (populated when status is "changed")
	ChangeReason string              `json:"change_reason,omitempty"`
	ChangedBy    string              `json:"changed_by,omitempty"`
	ChangedAt    *time.Time          `json:"changed_at,omitempty"`
	ChangesDiff  []ContributionDiff  `json:"changes_diff,omitempty"`

	// Evidence & completion (extended)
	AcceptanceNotes   []string  `json:"acceptance_notes,omitempty"`
	EvidenceURLs      []string  `json:"evidence_urls,omitempty"`
	EvidenceFiles     []FileRef `json:"evidence_files,omitempty"`
	TimeReportFile    *FileRef  `json:"time_report_file,omitempty"`
	AttachmentFiles   []FileRef `json:"attachment_files,omitempty"`
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
