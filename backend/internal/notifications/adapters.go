package notifications

import (
	"github.com/matou-dao/backend/internal/api"
	"github.com/matou-dao/backend/internal/email"
)

// SSEBrokerAdapter adapts api.EventBroker to the notifications.Broadcaster interface.
// It translates notifications.SSEEvent to api.SSEEvent before broadcasting.
type SSEBrokerAdapter struct {
	broker *api.EventBroker
}

// NewSSEBrokerAdapter creates an adapter wrapping the given EventBroker.
func NewSSEBrokerAdapter(broker *api.EventBroker) *SSEBrokerAdapter {
	return &SSEBrokerAdapter{broker: broker}
}

// Broadcast implements Broadcaster by forwarding to the underlying api.EventBroker.
func (a *SSEBrokerAdapter) Broadcast(event SSEEvent) {
	a.broker.Broadcast(api.SSEEvent{
		Type: event.Type,
		Data: event.Data,
	})
}

// EmailAdapter adapts email.Sender to the notifications.EmailSender interface.
type EmailAdapter struct {
	sender *email.Sender
}

// NewEmailAdapter creates an adapter wrapping the given email.Sender.
func NewEmailAdapter(sender *email.Sender) *EmailAdapter {
	return &EmailAdapter{sender: sender}
}

// Send implements EmailSender by delegating to email.Sender.SendGeneric.
// SendGeneric is added to email.Sender as part of the contributions system implementation.
func (a *EmailAdapter) Send(notif EmailNotification) error {
	return a.sender.SendGeneric(notif.To, notif.Subject, notif.Body)
}
