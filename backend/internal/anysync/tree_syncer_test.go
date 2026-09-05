// Package anysync tests for the missing-tree backoff/park behaviour (#129, #393).
package anysync

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
)

// fakeClock is a manually-advanced clock for deterministic backoff tests.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{t: time.Unix(0, 0)} }

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// TestTreeSyncerBackoffCadence asserts the retry delay doubles from backoffBase
// and saturates at backoffMax — i.e. the retry cadence decays to the cap.
func TestTreeSyncerBackoffCadence(t *testing.T) {
	clk := newFakeClock()
	b := newBackoffTracker()
	b.now = clk.now

	const id = "tree-A"
	want := []time.Duration{
		5 * time.Second,
		10 * time.Second,
		20 * time.Second,
		40 * time.Second,
		80 * time.Second,
		160 * time.Second,
		backoffMax, // 320s would exceed 5m → capped
		backoffMax,
		backoffMax,
	}
	for i, w := range want {
		// Eligible now (or after advancing past the previous window).
		if !b.claim(id) {
			t.Fatalf("failure %d: expected claim to succeed", i+1)
		}
		delay, _, _ := b.recordFailure(id)
		if delay != w {
			t.Fatalf("failure %d: delay = %s, want %s", i+1, delay, w)
		}
		// Before the window elapses the tree must not be re-claimable.
		if b.claim(id) {
			t.Fatalf("failure %d: claim succeeded inside backoff window", i+1)
		}
		clk.advance(delay)
	}
}

// TestTreeSyncerBackoffResetOnSuccess asserts a success clears the counter so
// the next failure starts again from backoffBase.
func TestTreeSyncerBackoffResetOnSuccess(t *testing.T) {
	clk := newFakeClock()
	b := newBackoffTracker()
	b.now = clk.now

	const id = "tree-B"
	// Two failures → delay should have grown to 10s.
	b.claim(id)
	b.recordFailure(id)
	clk.advance(5 * time.Second)
	b.claim(id)
	if d, _, _ := b.recordFailure(id); d != 10*time.Second {
		t.Fatalf("second failure delay = %s, want 10s", d)
	}
	clk.advance(10 * time.Second)

	// Success resets everything.
	b.claim(id)
	if wasParked := b.recordSuccess(id); wasParked {
		t.Fatalf("recordSuccess reported parked for a non-parked tree")
	}

	// Next failure starts again from backoffBase.
	if !b.claim(id) {
		t.Fatalf("expected claim to succeed after success reset")
	}
	if d, _, _ := b.recordFailure(id); d != backoffBase {
		t.Fatalf("post-reset failure delay = %s, want %s", d, backoffBase)
	}
}

// TestTreeSyncerParkTransitions asserts the park flag flips exactly once at the
// threshold and clears on recovery — the signal used to log at most once past
// the cap and to expose the parked set.
func TestTreeSyncerParkTransitions(t *testing.T) {
	clk := newFakeClock()
	b := newBackoffTracker()
	b.now = clk.now

	const id = "tree-C"
	justParkedCount := 0
	for i := 0; i < parkThreshold+3; i++ {
		b.claim(id)
		_, justParked, parked := b.recordFailure(id)
		if justParked {
			justParkedCount++
		}
		if i+1 >= parkThreshold && !parked {
			t.Fatalf("failure %d: expected parked=true", i+1)
		}
		if i+1 < parkThreshold && parked {
			t.Fatalf("failure %d: expected parked=false", i+1)
		}
		clk.advance(backoffMax)
	}
	if justParkedCount != 1 {
		t.Fatalf("justParked fired %d times, want exactly 1", justParkedCount)
	}
	if got := b.parkedTrees(); len(got) != 1 || got[0] != id {
		t.Fatalf("parkedTrees = %v, want [%s]", got, id)
	}

	// Recovery clears the parked state.
	if wasParked := b.recordSuccess(id); !wasParked {
		t.Fatalf("recordSuccess should report wasParked=true after parking")
	}
	if got := b.parkedTrees(); len(got) != 0 {
		t.Fatalf("parkedTrees after recovery = %v, want empty", got)
	}
}

// failingTreeManager is a fake treeGetter whose GetTree always fails, counting
// the number of times it is invoked for a given tree.
type failingTreeManager struct {
	mu    sync.Mutex
	calls map[string]int
	err   error
}

func newFailingTreeManager() *failingTreeManager {
	return &failingTreeManager{calls: make(map[string]int), err: errors.New("storage boom")}
}

func (f *failingTreeManager) GetTree(_ context.Context, _, treeID string) (objecttree.ObjectTree, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls[treeID]++
	return nil, f.err
}

func (f *failingTreeManager) callCount(treeID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[treeID]
}

// TestTreeSyncerWorkerRetryCadenceCapped drives the worker through repeated
// HeadSync cycles with a fake clock and asserts that a permanently-failing tree
// is not re-fetched every cycle — the backoff gate spaces retries out and, once
// parked, the tree is fetched at most once per backoffMax window (no more "every
// 5s forever" loop, #129).
func TestTreeSyncerWorkerRetryCadenceCapped(t *testing.T) {
	clk := newFakeClock()
	fm := newFailingTreeManager()

	ts := newMatouTreeSyncer("space-1", nil)
	ts.treeManager = fm
	ts.backoff.now = clk.now
	// Init() would resolve the component graph; drive the worker pool directly.
	ts.startWorkers()
	defer func() { _ = ts.Close(context.Background()) }()

	const id = "tree-loop"
	p := &mockPeer{} // package-local peer.Peer fake (Id() == "mock-file-peer")

	// waitIdle blocks until the worker pool has fully drained the current cycle,
	// i.e. no tree is in flight. Because claim() marks a tree in-flight before it
	// is enqueued and the worker clears it only after recordFailure, this
	// guarantees any failure this cycle is recorded (nextRetry set relative to the
	// current clock) before we advance time — making the cadence deterministic.
	waitIdle := func() {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if !ts.backoff.anyInFlight() {
				return
			}
			time.Sleep(time.Millisecond)
		}
		t.Fatalf("timed out waiting for worker pool to drain")
	}

	// Simulate 100 HeadSync cycles at the real ~5s SyncPeriod. Without backoff
	// this fetches the tree 100 times; with backoff the retries decay to the cap.
	const cycles = 100
	const period = 5 * time.Second
	for i := 0; i < cycles; i++ {
		if err := ts.SyncAll(context.Background(), p, nil, []string{id}); err != nil {
			t.Fatalf("SyncAll: %v", err)
		}
		waitIdle()
		clk.advance(period)
	}

	calls := fm.callCount(id)
	// Cadence for the first parkThreshold failures: 5,10,20,40,80s (spanning the
	// first ~155s → ~31 cycles) then backoffMax (300s = 60 cycles) each. Over 100
	// cycles (~500s) that is far fewer than 100 fetches. Assert it is well under
	// half — the loop is broken.
	if calls >= cycles/2 {
		t.Fatalf("tree fetched %d times over %d cycles — backoff not limiting retries", calls, cycles)
	}
	if got := ts.backoff.parkedTrees(); len(got) != 1 || got[0] != id {
		t.Fatalf("parkedTrees = %v, want [%s] after sustained failures", got, id)
	}
	t.Logf("tree fetched %d times over %d cycles (%s)", calls, cycles, fmt.Sprint(time.Duration(cycles)*period))
}
