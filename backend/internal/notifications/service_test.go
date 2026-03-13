package notifications

import (
	"testing"
)

// MockBroker is a test double for Broadcaster.
type MockBroker struct {
	events []SSEEvent
}

func (m *MockBroker) Broadcast(event SSEEvent) {
	m.events = append(m.events, event)
}

// MockEmailSender is a test double for EmailSender.
type MockEmailSender struct {
	sent []EmailNotification
}

func (m *MockEmailSender) Send(notif EmailNotification) error {
	m.sent = append(m.sent, notif)
	return nil
}

func TestService_NotifyInApp(t *testing.T) {
	broker := &MockBroker{}
	svc := NewService(broker, nil)

	err := svc.Notify(&Notification{
		Type:        NotifyProposalSubmitted,
		RecipientID: "user-1",
		Title:       "New proposal",
		Message:     "A proposal was submitted",
		EntityID:    "prop-1",
		EntityType:  "proposal",
		Channel:     ChannelInApp,
	})
	if err != nil {
		t.Fatalf("Notify failed: %v", err)
	}
	if len(broker.events) != 1 {
		t.Errorf("expected 1 broadcast, got %d", len(broker.events))
	}
}

func TestService_NotifyEmail(t *testing.T) {
	emailSender := &MockEmailSender{}
	svc := NewService(nil, emailSender)

	err := svc.NotifyEmail(&EmailNotification{
		To:      "user@example.com",
		Subject: "Proposal approved",
		Body:    "Your proposal has been approved.",
	})
	if err != nil {
		t.Fatalf("NotifyEmail failed: %v", err)
	}
	if len(emailSender.sent) != 1 {
		t.Errorf("expected 1 email, got %d", len(emailSender.sent))
	}
}

func TestService_NotifyBoth(t *testing.T) {
	broker := &MockBroker{}
	emailSender := &MockEmailSender{}
	svc := NewService(broker, emailSender)

	err := svc.NotifyWithEmail(&Notification{
		Type:        NotifyContributionAssigned,
		RecipientID: "user-1",
		Title:       "Assigned",
		Message:     "You were assigned a contribution",
		EntityID:    "ctr-1",
		EntityType:  "contribution",
		Channel:     ChannelBoth,
	}, "user@example.com")
	if err != nil {
		t.Fatalf("failed: %v", err)
	}
	if len(broker.events) != 1 {
		t.Errorf("expected 1 SSE event, got %d", len(broker.events))
	}
	if len(emailSender.sent) != 1 {
		t.Errorf("expected 1 email, got %d", len(emailSender.sent))
	}
}

func TestService_Notify_NoBroker(t *testing.T) {
	// No broker — should succeed without panicking
	svc := NewService(nil, nil)

	err := svc.Notify(&Notification{
		Type:        NotifyProposalSubmitted,
		RecipientID: "user-1",
		Title:       "Test",
		Message:     "msg",
		Channel:     ChannelInApp,
	})
	if err != nil {
		t.Errorf("expected no error when broker is nil, got %v", err)
	}
}

func TestService_NotifyEmail_NoSender(t *testing.T) {
	svc := NewService(nil, nil)

	err := svc.NotifyEmail(&EmailNotification{
		To:      "x@example.com",
		Subject: "s",
		Body:    "b",
	})
	if err == nil {
		t.Error("expected error when email sender is nil")
	}
}

func TestService_AssignsIDAndTimestamp(t *testing.T) {
	broker := &MockBroker{}
	svc := NewService(broker, nil)

	n := &Notification{
		Type:        NotifyProposalSubmitted,
		RecipientID: "user-1",
		Title:       "t",
		Message:     "m",
		Channel:     ChannelInApp,
	}
	svc.Notify(n)

	if n.ID == "" {
		t.Error("expected ID to be set")
	}
	if n.CreatedAt.IsZero() {
		t.Error("expected CreatedAt to be set")
	}
}
