package anysync

import (
	"fmt"
	"testing"
	"time"
)

// eventData returns an SSE event's data map, failing the test if it is not one.
func eventData(t *testing.T, e SSEEvent) map[string]interface{} {
	t.Helper()
	d, ok := e.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("event %s: unexpected data type %T", e.Type, e.Data)
	}
	return d
}

// Regression for #559. `seeded` used to be one listener-wide bool set true at
// the end of every processChanges call, so only whichever tree was processed
// first after boot was suppressed — every other tree in a cold-sync backlog was
// broadcast as a live change. Now every event is stamped `historical` from the
// change's own timestamp, so the whole backlog is marked non-live regardless of
// order, and a genuinely-new change after the backfill is still live.
func TestProcessChanges_ColdSyncBacklogNotAnnouncedLive(t *testing.T) {
	acl, owner, _ := twoWriterACL(t)
	broker := &recordingBroker{}
	l := NewTreeUpdateListener(nil, broker)

	// Cold-sync backlog: N (>=3) pre-existing project trees, each carrying only
	// old changes, arrive as the listener rebuilds them from a fresh pull.
	const backlog = 4
	old := time.Now().Add(-24 * time.Hour).Unix()
	for i := 0; i < backlog; i++ {
		id := fmt.Sprintf("project-%d", i)
		tree := newEncryptedTree(t, acl, owner, id, TypeProject)
		addOps(t, tree, owner.Keys.SignKey, old, true, setOp("name", id), setOp("status", "active"))
		if err := l.Rebuild(tree); err != nil {
			t.Fatalf("Rebuild %s: %v", id, err)
		}
	}

	// Every backlog tree still emits (stores/unread counts need it) but NONE as
	// a live event — that is the guarantee the old first-tree-wins gate broke.
	if len(broker.events) != backlog {
		t.Fatalf("want %d backlog events, got %d: %+v", backlog, len(broker.events), broker.events)
	}
	for _, e := range broker.events {
		if got := eventData(t, e)["historical"]; got != true {
			t.Errorf("backlog event %s announced as live (historical=%v)", e.Type, got)
		}
	}

	// A genuinely-new change arriving after the backfill is still announced live
	// (no over-suppression).
	broker.events = nil
	liveTree := newEncryptedTree(t, acl, owner, "project-live", TypeProject)
	addOps(t, liveTree, owner.Keys.SignKey, time.Now().Unix(), true, setOp("name", "live"), setOp("status", "active"))
	if err := l.Rebuild(liveTree); err != nil {
		t.Fatalf("Rebuild live: %v", err)
	}
	if len(broker.events) != 1 {
		t.Fatalf("want 1 live event, got %d: %+v", len(broker.events), broker.events)
	}
	if got := eventData(t, broker.events[0])["historical"]; got != false {
		t.Errorf("live change not announced as live (historical=%v)", got)
	}
}

// isHistoricalPayload is the generic counterpart of isHistoricalChatMessage: a
// missing/zero timestamp is treated as live (unknown age keeps old behaviour),
// a recent one is live, an old one is historical.
func TestIsHistoricalPayload(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name string
		ts   int64
		want bool
	}{
		{"missing timestamp", 0, false},
		{"just now", now.Unix(), false},
		{"within live window", now.Add(-2 * time.Minute).Unix(), false},
		{"older than live window", now.Add(-2 * historicalWindow).Unix(), true},
		{"days old", now.Add(-72 * time.Hour).Unix(), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isHistoricalPayload(&ObjectPayload{Timestamp: tc.ts}, now); got != tc.want {
				t.Errorf("isHistoricalPayload(ts=%d) = %v, want %v", tc.ts, got, tc.want)
			}
		})
	}
}
