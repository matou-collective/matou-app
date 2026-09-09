package notifications

import "time"

// NotificationType identifies the kind of event that triggered a notification.
type NotificationType string

// Notification type values identifying the event that triggered a notification.
const (
	// NotifyProposalSubmitted fires when a proposal is submitted for review.
	NotifyProposalSubmitted NotificationType = "proposal:submitted"
	// NotifyProposalEndorsed fires when a proposal receives an endorsement.
	NotifyProposalEndorsed NotificationType = "proposal:endorsed"
	// NotifyProposalApproved fires when a proposal is approved.
	NotifyProposalApproved NotificationType = "proposal:approved"
	// NotifyProposalRejected fires when a proposal is rejected.
	NotifyProposalRejected NotificationType = "proposal:rejected"
	// NotifyProjectCreated fires when a new project is created.
	NotifyProjectCreated NotificationType = "project:created"
	// NotifyContributionAssigned fires when a contribution is assigned to a contributor.
	NotifyContributionAssigned NotificationType = "contribution:assigned"
	// NotifyContributionReview fires when a contribution needs review.
	NotifyContributionReview NotificationType = "contribution:needs_review"
	// NotifyContributionApproved fires when a contribution is approved.
	NotifyContributionApproved NotificationType = "contribution:approved"
	// NotifyContributionDeclined fires when a contribution is declined.
	NotifyContributionDeclined NotificationType = "contribution:declined"
	// NotifyContributionRegistered fires when a contribution is registered.
	NotifyContributionRegistered NotificationType = "contribution:registered"
	// NotifyContributionEvidenceEdited fires when the assigned contributor amended a
	// submission before sign-off (lead + voided reviewer are the recipients).
	NotifyContributionEvidenceEdited NotificationType = "contribution:evidence_edited"
	// NotifyDecisionPlanSubmitted fires when a decision plan is submitted.
	NotifyDecisionPlanSubmitted NotificationType = "decision_plan:submitted"
	// NotifyDecisionPlanSignedOff fires when a decision plan is signed off.
	NotifyDecisionPlanSignedOff NotificationType = "decision_plan:signed_off"
	// NotifyGovActionCompleted fires when a governance action is completed.
	NotifyGovActionCompleted NotificationType = "governance_action:completed"
)

// DeliveryChannel controls how a notification is delivered.
type DeliveryChannel string

// Delivery channel values controlling how a notification is delivered.
const (
	// ChannelInApp delivers the notification only in-app (SSE).
	ChannelInApp DeliveryChannel = "in_app"
	// ChannelEmail delivers the notification only via email.
	ChannelEmail DeliveryChannel = "email"
	// ChannelBoth delivers the notification both in-app and via email.
	ChannelBoth DeliveryChannel = "both"
)

// Notification is an in-app notification sent via SSE.
type Notification struct {
	ID          string           `json:"id"`
	Type        NotificationType `json:"type"`
	RecipientID string           `json:"recipient_id"`
	Title       string           `json:"title"`
	Message     string           `json:"message"`
	EntityID    string           `json:"entity_id"`
	EntityType  string           `json:"entity_type"`
	Read        bool             `json:"read"`
	Channel     DeliveryChannel  `json:"channel"`
	CreatedAt   time.Time        `json:"created_at"`
}

// EmailNotification holds data for email delivery.
type EmailNotification struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
}
