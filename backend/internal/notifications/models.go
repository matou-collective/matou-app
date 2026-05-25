package notifications

import "time"

// NotificationType identifies the kind of event that triggered a notification.
type NotificationType string

const (
	NotifyProposalSubmitted     NotificationType = "proposal:submitted"
	NotifyProposalEndorsed      NotificationType = "proposal:endorsed"
	NotifyProposalApproved      NotificationType = "proposal:approved"
	NotifyProposalRejected      NotificationType = "proposal:rejected"
	NotifyProjectCreated        NotificationType = "project:created"
	NotifyContributionAssigned  NotificationType = "contribution:assigned"
	NotifyContributionReview    NotificationType = "contribution:needs_review"
	NotifyContributionApproved  NotificationType = "contribution:approved"
	NotifyContributionDeclined  NotificationType = "contribution:declined"
	NotifyContributionRegistered NotificationType = "contribution:registered"
	NotifyDecisionPlanSubmitted NotificationType = "decision_plan:submitted"
	NotifyDecisionPlanSignedOff NotificationType = "decision_plan:signed_off"
	NotifyGovActionCompleted    NotificationType = "governance_action:completed"
)

// DeliveryChannel controls how a notification is delivered.
type DeliveryChannel string

const (
	ChannelInApp DeliveryChannel = "in_app"
	ChannelEmail DeliveryChannel = "email"
	ChannelBoth  DeliveryChannel = "both"
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
