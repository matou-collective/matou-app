package anysync

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
)

// hangingTreeManager is a treeGetter whose GetTree only returns when its
// context ends — a fetch whose response never arrives.
type hangingTreeManager struct{}

func (hangingTreeManager) GetTree(ctx context.Context, _, _ string) (objecttree.ObjectTree, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// A lost response used to park the worker for the life of the process (the
// fetch ran on context.Background()), and the tree stayed in flight so it was
// never queued again (#570).
func TestMissingWorker_AbandonsAFetchThatNeverAnswers(t *testing.T) {
	ts := newMatouTreeSyncer("space-1", nil)
	ts.treeManager = hangingTreeManager{}
	ts.fetchTimeout = 50 * time.Millisecond
	ts.startWorkers()
	defer func() { _ = ts.Close(context.Background()) }()

	if err := ts.SyncAll(context.Background(), &mockPeer{}, nil, []string{"tree-lost"}); err != nil {
		t.Fatalf("SyncAll: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for ts.backoff.anyInFlight() {
		if time.Now().After(deadline) {
			t.Fatal("the fetch is still in flight: the worker is parked on a response that will never come")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if ts.backoff.claim("tree-lost") {
		t.Fatal("the abandoned fetch was not recorded as a failure (no retry backoff)")
	}
}

// Closing a space waits for its workers. Reinitialize closes spaces inside
// POST /identity/set, so Close must cut in-flight fetches short rather than
// wait out their deadline.
func TestTreeSyncerClose_CancelsInFlightFetches(t *testing.T) {
	ts := newMatouTreeSyncer("space-1", nil)
	ts.treeManager = hangingTreeManager{}
	ts.startWorkers()
	if err := ts.SyncAll(context.Background(), &mockPeer{}, []string{"tree-b"}, []string{"tree-a"}); err != nil {
		t.Fatalf("SyncAll: %v", err)
	}
	time.Sleep(20 * time.Millisecond) // let the workers pick the items up

	closed := make(chan struct{})
	go func() { _ = ts.Close(context.Background()); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("Close is waiting for a fetch that will not answer")
	}
}

// A fetch cut short by Close is not a failed fetch: it must not be logged as
// one (a phone logged 305 of them in the second Reinitialize ran) nor earn the
// tree a retry backoff.
func TestTreeSyncerClose_DoesNotCountCancelledFetchesAsFailures(t *testing.T) {
	ts := newMatouTreeSyncer("space-1", nil)
	ts.treeManager = hangingTreeManager{}
	ts.startWorkers()
	ids := make([]string, 40) // more than the 10 workers, so some are still queued
	for i := range ids {
		ids[i] = fmt.Sprintf("tree-%02d", i)
	}
	if err := ts.SyncAll(context.Background(), &mockPeer{}, nil, ids); err != nil {
		t.Fatalf("SyncAll: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	_ = ts.Close(context.Background())

	for _, id := range ids {
		if !ts.backoff.claim(id) {
			t.Fatalf("%s was given a retry backoff for a fetch that Close cancelled", id)
		}
	}
}

// Recovery runs right after a fetch failed, handed that fetch's context — which
// may be the very deadline that just expired. any-store interrupts SQLite on a
// done context, so recovery needs a live one of its own.
func TestRecoveryCtx_OutlivesAnExpiredFetchContext(t *testing.T) {
	expired, cancel := context.WithCancel(context.Background())
	cancel()

	ctx, done := recoveryCtx(expired)
	defer done()
	if err := ctx.Err(); err != nil {
		t.Fatalf("recovery context is already done: %v", err)
	}
	if _, bounded := ctx.Deadline(); !bounded {
		t.Fatal("recovery context has no deadline")
	}
}
