package notifications

import (
	"crypto/rand"
	"fmt"
	"log"
	"time"
)

// SSEEvent matches api.SSEEvent — defined here so the notifications package
// has no import cycle dependency on the api package.
// The SSEBrokerAdapter in adapters.go translates between the two.
type SSEEvent struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// Broadcaster wraps an EventBroker for sending SSE events.
// Implemented by SSEBrokerAdapter in adapters.go.
type Broadcaster interface {
	Broadcast(event SSEEvent)
}

// EmailSender delivers an email notification.
// Implemented by EmailAdapter in adapters.go.
type EmailSender interface {
	Send(notif EmailNotification) error
}

// Service sends notifications via SSE and/or email.
type Service struct {
	broker Broadcaster
	email  EmailSender
}

// NewService creates a new notification service.
// Either broker or email may be nil if that channel is not configured.
func NewService(broker Broadcaster, email EmailSender) *Service {
	return &Service{
		broker: broker,
		email:  email,
	}
}

func generateID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return fmt.Sprintf("notif_%x", b)
}

// Notify sends an in-app notification via SSE broadcast.
// If no broker is configured the call is a no-op (returns nil).
func (s *Service) Notify(n *Notification) error {
	if n.ID == "" {
		n.ID = generateID()
	}
	if n.CreatedAt.IsZero() {
		n.CreatedAt = time.Now()
	}

	if s.broker != nil {
		s.broker.Broadcast(SSEEvent{
			Type: string(n.Type),
			Data: n,
		})
		log.Printf("[Notifications] in-app notification sent: %s to %s", n.Type, n.RecipientID)
	}
	return nil
}

// NotifyEmail sends an email notification.
// Returns an error if no email sender is configured.
func (s *Service) NotifyEmail(e *EmailNotification) error {
	if s.email == nil {
		return fmt.Errorf("email sender not configured")
	}
	if err := s.email.Send(*e); err != nil {
		log.Printf("[Notifications] email notification failed: %v", err)
		return err
	}
	log.Printf("[Notifications] email sent to %s: %s", e.To, e.Subject)
	return nil
}

// NotifyWithEmail sends both an SSE notification and an email to the given address.
func (s *Service) NotifyWithEmail(n *Notification, emailAddr string) error {
	if err := s.Notify(n); err != nil {
		return err
	}
	return s.NotifyEmail(&EmailNotification{
		To:      emailAddr,
		Subject: n.Title,
		Body:    n.Message,
	})
}
