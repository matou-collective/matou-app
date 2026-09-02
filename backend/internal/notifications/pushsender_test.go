package notifications

import (
	"bytes"
	"context"
	"errors"
	"log"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

// stubRelay records the Notify calls a PushSender makes.
type stubRelay struct {
	mu    sync.Mutex
	calls []notifyCall
	err   error
}

type notifyCall struct {
	recipients []string
	channel    string
	kind       string
}

func (s *stubRelay) Notify(_ context.Context, recipients []string, channel, kind string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, notifyCall{recipients: recipients, channel: channel, kind: kind})
	return s.err
}

func (s *stubRelay) lastCall() (notifyCall, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.calls) == 0 {
		return notifyCall{}, false
	}
	return s.calls[len(s.calls)-1], true
}

func (s *stubRelay) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.calls)
}

// membersStub returns a fixed member list for any channel.
type membersStub struct {
	members []string
	err     error
}

func (m membersStub) ChannelMembers(string) ([]string, error) { return m.members, m.err }

func msgEvent(channelID, senderAID string) SSEEvent {
	return SSEEvent{
		Type: "chat:message:new",
		Data: map[string]interface{}{
			"channelId": channelID,
			"senderAid": senderAID,
			"content":   "hello",
		},
	}
}

func TestPushSender_MapsMessageToNotify(t *testing.T) {
	relay := &stubRelay{}
	members := membersStub{members: []string{"aid-alice", "aid-bob", "aid-carol"}}
	s := NewPushSender(relay, members)

	s.Broadcast(msgEvent("chan-1", "aid-alice"))

	call, ok := relay.lastCall()
	if !ok {
		t.Fatal("expected a relay Notify call")
	}
	if call.channel != "chan-1" {
		t.Errorf("channel = %q, want chan-1", call.channel)
	}
	if call.kind != "ch" {
		t.Errorf("kind = %q, want ch (default)", call.kind)
	}
	got := append([]string(nil), call.recipients...)
	sort.Strings(got)
	want := []string{"aid-bob", "aid-carol"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("recipients = %v, want %v (sender excluded)", got, want)
	}
}

// TestPushSender_NoSession_DropsAndLogsOncePerGap: when the relay has no valid
// session (Notify errors, chiefly ErrNoSession because the frontend has not
// signed one) every message is still attempted — the broadcast path never blocks
// — but the failure is logged at most once per gap, not once per message. A
// later success resets the latch so the next gap is reported again.
func TestPushSender_NoSession_DropsAndLogsOncePerGap(t *testing.T) {
	relay := &stubRelay{err: errors.New("push-relay: no active session")}
	members := membersStub{members: []string{"aid-alice", "aid-bob"}}
	s := NewPushSender(relay, members)

	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	// Three messages during the session gap: three drops, one log line.
	for i := 0; i < 3; i++ {
		s.Broadcast(msgEvent("chan-1", "aid-alice"))
	}
	if relay.count() != 3 {
		t.Fatalf("expected 3 notify attempts (never blocked/skipped), got %d", relay.count())
	}
	if n := strings.Count(buf.String(), "notify relay for channel"); n != 1 {
		t.Fatalf("expected exactly one log line during the gap, got %d:\n%s", n, buf.String())
	}

	// The session comes back: a success resets the latch...
	relay.mu.Lock()
	relay.err = nil
	relay.mu.Unlock()
	s.Broadcast(msgEvent("chan-1", "aid-alice"))

	// ...so the next gap is logged again (once).
	relay.mu.Lock()
	relay.err = errors.New("push-relay: no active session")
	relay.mu.Unlock()
	buf.Reset()
	s.Broadcast(msgEvent("chan-1", "aid-alice"))
	s.Broadcast(msgEvent("chan-1", "aid-alice"))
	if n := strings.Count(buf.String(), "notify relay for channel"); n != 1 {
		t.Fatalf("expected the recovered-then-failed gap to log once, got %d:\n%s", n, buf.String())
	}
}

func TestPushSender_ExcludesSender(t *testing.T) {
	relay := &stubRelay{}
	members := membersStub{members: []string{"aid-alice", "aid-bob"}}
	s := NewPushSender(relay, members)

	s.Broadcast(msgEvent("chan-1", "aid-alice"))

	call, _ := relay.lastCall()
	for _, r := range call.recipients {
		if r == "aid-alice" {
			t.Fatalf("sender aid-alice must not be a recipient: %v", call.recipients)
		}
	}
}

func TestPushSender_ExcludesOptedOut(t *testing.T) {
	relay := &stubRelay{}
	members := membersStub{members: []string{"aid-alice", "aid-bob", "aid-carol"}}
	s := NewPushSender(relay, members)
	s.SetOptOutChecker(func(aid string) bool { return aid == "aid-bob" })

	s.Broadcast(msgEvent("chan-1", "aid-alice"))

	call, _ := relay.lastCall()
	got := append([]string(nil), call.recipients...)
	sort.Strings(got)
	want := []string{"aid-carol"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("recipients = %v, want %v (sender + opted-out excluded)", got, want)
	}
}

func TestPushSender_NilRelayIsNoOp(t *testing.T) {
	members := membersStub{members: []string{"aid-alice", "aid-bob"}}
	s := NewPushSender(nil, members)
	// Must not panic and must be a silent no-op.
	s.Broadcast(msgEvent("chan-1", "aid-alice"))

	// Also: a configured relay with a nil member resolver is a no-op.
	relay := &stubRelay{}
	s2 := NewPushSender(relay, nil)
	s2.Broadcast(msgEvent("chan-1", "aid-alice"))
	if relay.count() != 0 {
		t.Errorf("expected no relay calls with nil member resolver, got %d", relay.count())
	}
}

func TestPushSender_DMvsChannelPriority(t *testing.T) {
	relay := &stubRelay{}
	members := membersStub{members: []string{"aid-alice", "aid-bob"}}
	s := NewPushSender(relay, members)
	s.SetKindResolver(func(channelID string) string {
		if channelID == "dm-1" {
			return "dm"
		}
		return "ch"
	})

	s.Broadcast(msgEvent("dm-1", "aid-alice"))
	if call, _ := relay.lastCall(); call.kind != "dm" {
		t.Errorf("DM kind = %q, want dm", call.kind)
	}

	s.Broadcast(msgEvent("chan-2", "aid-alice"))
	if call, _ := relay.lastCall(); call.kind != "ch" {
		t.Errorf("channel kind = %q, want ch", call.kind)
	}
}

func TestPushSender_IgnoresNonChatEvents(t *testing.T) {
	relay := &stubRelay{}
	members := membersStub{members: []string{"aid-alice", "aid-bob"}}
	s := NewPushSender(relay, members)

	s.Broadcast(SSEEvent{Type: "contribution:updated", Data: map[string]interface{}{"channelId": "chan-1"}})
	s.Broadcast(SSEEvent{Type: "chat:channel:new", Data: map[string]interface{}{"channelId": "chan-1"}})

	if relay.count() != 0 {
		t.Errorf("expected no relay calls for non-message events, got %d", relay.count())
	}
}

func TestPushSender_SkipsP2PReplicatedMessages(t *testing.T) {
	relay := &stubRelay{}
	members := membersStub{members: []string{"aid-alice", "aid-bob"}}
	s := NewPushSender(relay, members)

	// A message replicated from a peer re-broadcasts chat:message:new tagged
	// source=p2p; only the sender's own node should fire a push.
	s.Broadcast(SSEEvent{
		Type: "chat:message:new",
		Data: map[string]interface{}{
			"channelId": "chan-1",
			"senderAid": "aid-alice",
			"source":    "p2p",
		},
	})
	if relay.count() != 0 {
		t.Errorf("expected no relay calls for p2p-replicated message, got %d", relay.count())
	}
}

func TestPushSender_NoRecipientsNoCall(t *testing.T) {
	relay := &stubRelay{}
	// Sender is the only member → no one left to notify.
	members := membersStub{members: []string{"aid-alice"}}
	s := NewPushSender(relay, members)

	s.Broadcast(msgEvent("chan-1", "aid-alice"))
	if relay.count() != 0 {
		t.Errorf("expected no relay call when sender is the only member, got %d", relay.count())
	}
}

func TestPushSender_MemberResolverErrorSwallowed(t *testing.T) {
	relay := &stubRelay{}
	members := membersStub{err: errors.New("acl unavailable")}
	s := NewPushSender(relay, members)

	// Must not panic and must not call the relay when membership can't resolve.
	s.Broadcast(msgEvent("chan-1", "aid-alice"))
	if relay.count() != 0 {
		t.Errorf("expected no relay call on member-resolution error, got %d", relay.count())
	}
}
