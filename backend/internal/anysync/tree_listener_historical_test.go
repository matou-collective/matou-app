package anysync

import (
	"encoding/json"
	"testing"
	"time"
)

type recordingBroker struct{ events []SSEEvent }

func (r *recordingBroker) Broadcast(e SSEEvent) { r.events = append(r.events, e) }

func chatMessagePayload(t *testing.T, sentAt string) *ObjectPayload {
	t.Helper()
	data, err := json.Marshal(map[string]string{
		"channelId": "ChatChannel-1", "senderAid": "EAlice", "senderName": "Alice",
		"content": "kia ora", "sentAt": sentAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &ObjectPayload{ID: "ChatMessage-1", Type: "ChatMessage", Data: data}
}

// Regression for #556. A device pulling a space from scratch (a fresh link, a
// recovery, a quarantined store re-syncing) receives every message ever sent as
// a tree it has not seen before. Those must still reach the frontend — the chat
// store and unread counts need them — but flagged, so they are not each toasted
// and pushed to the OS as if they had just been sent.
func TestEmitSSE_ChatMessageNew_FlagsHistoricalMessages(t *testing.T) {
	cases := []struct {
		name   string
		sentAt string
		want   bool
	}{
		{"just sent", time.Now().UTC().Add(-3 * time.Second).Format(time.RFC3339), false},
		{"sender clock slightly ahead", time.Now().UTC().Add(30 * time.Second).Format(time.RFC3339), false},
		{"sent last week", time.Now().UTC().Add(-7 * 24 * time.Hour).Format(time.RFC3339), true},
		{"sent while this device was offline", time.Now().UTC().Add(-2 * chatMessageLiveWindow).Format(time.RFC3339), true},
		// Unknown age: keep the old behaviour rather than silently hiding a toast.
		{"unparseable sentAt", "yesterday-ish", false},
		{"missing sentAt", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			broker := &recordingBroker{}
			l := NewTreeUpdateListener(nil, broker)

			l.emitSSE(chatMessagePayload(t, tc.sentAt), false)

			if len(broker.events) != 1 || broker.events[0].Type != "chat:message:new" {
				t.Fatalf("expected one chat:message:new event, got %+v", broker.events)
			}
			data, ok := broker.events[0].Data.(map[string]interface{})
			if !ok {
				t.Fatalf("unexpected event data type %T", broker.events[0].Data)
			}
			if got, _ := data["historical"].(bool); got != tc.want {
				t.Errorf("historical = %v, want %v", got, tc.want)
			}
			if data["messageId"] != "ChatMessage-1" || data["content"] != "kia ora" {
				t.Errorf("the event must still carry the message, got %+v", data)
			}
		})
	}
}
