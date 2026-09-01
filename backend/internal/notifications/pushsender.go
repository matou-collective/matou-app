package notifications

import (
	"context"
	"log"
	"time"
)

// PushRelay is the subset of the push-relay client the PushSender depends on.
// Implemented by *pushrelayclient.Client; stubbed in tests. Kept minimal so the
// notifications package needs no compile-time dependency on the relay client.
type PushRelay interface {
	// Notify wakes the given recipient AIDs for a new message in an opaque
	// channel. kind is the coarse priority tier ("dm" | "ch").
	Notify(ctx context.Context, recipients []string, channel, kind string) error
}

// ChannelMembers resolves the recipient AIDs for a channel from the space ACL.
// The concrete implementation (wired in app.go) reads the community-space ACL;
// tests supply a stub. It returns every member of the channel including the
// sender — PushSender removes the sender itself.
type ChannelMembers interface {
	ChannelMembers(channelID string) ([]string, error)
}

// ChannelMembersFunc adapts a plain function to the ChannelMembers interface.
type ChannelMembersFunc func(channelID string) ([]string, error)

// ChannelMembers implements ChannelMembers by calling the wrapped function.
func (f ChannelMembersFunc) ChannelMembers(channelID string) ([]string, error) {
	return f(channelID)
}

// PushSender is a notifications sink that turns a new-chat-message event into a
// content-free wake signal to the push-relay (docs/architecture/08-push-notifications.md
// §8). It mirrors SSEBrokerAdapter: it satisfies the Broadcaster interface so the
// chat write-path fan-out gains a third sink beside SSE and email. Non-chat
// events are ignored, and an unconfigured relay makes every call a no-op so
// dev/test and the Electron build are unaffected.
type PushSender struct {
	relay   PushRelay
	members ChannelMembers

	// kindFor classifies a channel into the coarse priority tier the relay maps
	// to an FCM priority ("dm" → high, "ch" → normal). Nil defaults every
	// channel to "ch" (there is no DM channel type yet — §4/§6).
	kindFor func(channelID string) string

	// optedOut reports whether an AID has opted out of push. Opt-out is chiefly
	// enforced at the relay (§7), but the sender drops opted-out recipients it
	// already knows about. Nil means no local opt-out state.
	optedOut func(aid string) bool
}

// NewPushSender builds a push sink forwarding to relay and resolving recipients
// via members. Either may be nil, in which case Broadcast is a no-op — this is
// how the feature stays dark until MATOU_PUSH_RELAY_URL is configured.
func NewPushSender(relay PushRelay, members ChannelMembers) *PushSender {
	return &PushSender{relay: relay, members: members}
}

// SetKindResolver overrides how channels are classified into priority tiers.
func (s *PushSender) SetKindResolver(fn func(channelID string) string) {
	s.kindFor = fn
}

// SetOptOutChecker sets the predicate used to drop opted-out recipients.
func (s *PushSender) SetOptOutChecker(fn func(aid string) bool) {
	s.optedOut = fn
}

// Broadcast implements the Broadcaster interface. It reacts only to
// chat:message:new events, resolving channel members from the ACL and asking the
// relay to wake them (minus the sender, minus opted-out). All other event types
// are ignored. Relay/ACL errors are logged and swallowed — a push failure must
// never break the chat write-path.
func (s *PushSender) Broadcast(event SSEEvent) {
	if s.relay == nil || s.members == nil {
		return
	}
	if event.Type != "chat:message:new" {
		return
	}

	data, ok := event.Data.(map[string]interface{})
	if !ok {
		return
	}
	// Only the sender's own node triggers a push (§3): it is the one that knows
	// a write happened and can read channel membership. A message replicated from
	// a peer re-broadcasts chat:message:new tagged source="p2p"; skip it, or every
	// recipient's backend would fan a duplicate push to the whole channel.
	if src, _ := data["source"].(string); src == "p2p" {
		return
	}
	channelID, _ := data["channelId"].(string)
	senderAID, _ := data["senderAid"].(string)
	if channelID == "" {
		return
	}

	members, err := s.members.ChannelMembers(channelID)
	if err != nil {
		log.Printf("[Push] resolving members for channel %s failed: %v", channelID, err)
		return
	}

	recipients := make([]string, 0, len(members))
	seen := make(map[string]bool, len(members))
	for _, aid := range members {
		if aid == "" || aid == senderAID || seen[aid] {
			continue // skip blanks, the sender itself, and duplicates
		}
		if s.optedOut != nil && s.optedOut(aid) {
			continue
		}
		seen[aid] = true
		recipients = append(recipients, aid)
	}
	if len(recipients) == 0 {
		return
	}

	kind := "ch"
	if s.kindFor != nil {
		if k := s.kindFor(channelID); k != "" {
			kind = k
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := s.relay.Notify(ctx, recipients, channelID, kind); err != nil {
		log.Printf("[Push] notify relay for channel %s failed: %v", channelID, err)
	}
}
