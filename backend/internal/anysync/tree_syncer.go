// Package anysync provides any-sync integration for MATOU.
// tree_syncer.go implements treesyncer.TreeSyncer for P2P tree synchronization.
// HeadSync discovers missing/changed trees via ldiff, then this syncer fetches
// and syncs them using the ObjectSync protocol.
//
// Architecture note: The any-sync SDK never calls StartSync()/StopSync() — only
// SyncAll() is invoked by HeadSync's DiffSyncer every ~5 seconds. Persistent
// worker pools are created in Init() and shut down in Close().
package anysync

import (
	"context"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/anyproto/any-sync/app"
	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/commonspace/object/tree/synctree"
	"github.com/anyproto/any-sync/commonspace/object/treemanager"
	"github.com/anyproto/any-sync/commonspace/object/treesyncer"
	"github.com/anyproto/any-sync/net/peer"
)

const (
	// missingTreeWorkers is the number of concurrent workers for fetching missing trees.
	// Missing trees require a full fetch from the remote peer, so parallelism helps.
	// Matches anytype-heart's request pool size.
	missingTreeWorkers = 10

	// existingTreeWorkers is the number of concurrent workers for syncing existing trees.
	// Existing tree head updates are lightweight, but parallelism still helps under load.
	existingTreeWorkers = 4

	// syncQueueSize is the buffer size for the work channels.
	syncQueueSize = 256

	// backoffBase is the delay after the first failed fetch of a missing tree.
	// Each subsequent consecutive failure doubles the delay (5s → 10s → 20s …).
	backoffBase = 5 * time.Second

	// backoffMax caps the per-tree retry delay. Without this, HeadSync re-queues
	// a permanently-failing tree every ~5s forever (see #129).
	backoffMax = 5 * time.Minute

	// parkThreshold is the number of consecutive failures after which a tree is
	// considered "parked": the noisy ERROR log is suppressed and the tree is only
	// retried at backoffMax cadence until it succeeds again.
	parkThreshold = 5
)

// treeGetter is the subset of treemanager.TreeManager the tree syncer needs.
// Narrowing the dependency lets tests drive the workers with a fake that only
// implements GetTree.
type treeGetter interface {
	GetTree(ctx context.Context, spaceID, treeID string) (objecttree.ObjectTree, error)
}

// treeBackoff holds the retry state for a single missing tree.
type treeBackoff struct {
	failures  int       // consecutive failure count, reset on success
	nextRetry time.Time // earliest time the tree may be re-queued
	inFlight  bool      // a worker is currently processing this tree
	parked    bool      // failures >= parkThreshold (noisy log suppressed)
}

// backoffTracker gates re-queuing of missing trees with per-tree exponential
// backoff and a failure cap. HeadSync calls SyncAll every ~5s with the same
// missing set; without gating, a persistently-failing tree burns CPU/battery in
// a tight retry loop. The clock is injectable for deterministic tests.
type backoffTracker struct {
	mu    sync.Mutex
	now   func() time.Time
	state map[string]*treeBackoff
}

func newBackoffTracker() *backoffTracker {
	return &backoffTracker{
		now:   time.Now,
		state: make(map[string]*treeBackoff),
	}
}

// claim marks a tree in-flight if it is eligible to be fetched now. It returns
// false when the tree is already being processed or is still within its backoff
// window, in which case the caller must not queue it. A claimed tree must be
// resolved with recordSuccess / recordFailure, or released with release.
func (b *backoffTracker) claim(treeID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.state[treeID]
	if st == nil {
		st = &treeBackoff{}
		b.state[treeID] = st
	}
	if st.inFlight {
		return false
	}
	if b.now().Before(st.nextRetry) {
		return false
	}
	st.inFlight = true
	return true
}

// release clears the in-flight flag without changing the failure state. Used
// when a claimed item could not be queued (e.g. the sync cycle was canceled).
func (b *backoffTracker) release(treeID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if st := b.state[treeID]; st != nil {
		st.inFlight = false
	}
}

// recordFailure increments the consecutive-failure counter, schedules the next
// retry with exponential backoff capped at backoffMax, and reports the chosen
// delay plus whether the tree just crossed the park threshold (justParked, so
// the caller logs the park line exactly once) and whether it is now parked (so
// the caller suppresses the per-failure ERROR log).
func (b *backoffTracker) recordFailure(treeID string) (delay time.Duration, justParked, parked bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.state[treeID]
	if st == nil {
		st = &treeBackoff{}
		b.state[treeID] = st
	}
	st.inFlight = false
	st.failures++

	// delay = backoffBase * 2^(failures-1), capped. Cap the shift first so the
	// multiplication can never overflow int64.
	shift := st.failures - 1
	if shift > 20 {
		shift = 20
	}
	delay = backoffBase << shift
	if delay <= 0 || delay > backoffMax {
		delay = backoffMax
	}
	st.nextRetry = b.now().Add(delay)

	if st.failures >= parkThreshold {
		parked = true
		if !st.parked {
			st.parked = true
			justParked = true
		}
	}
	return delay, justParked, parked
}

// recordSuccess clears all backoff state for a tree and reports whether it had
// been parked (so the caller can log the recovery as a state change).
func (b *backoffTracker) recordSuccess(treeID string) (wasParked bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if st := b.state[treeID]; st != nil {
		wasParked = st.parked
		delete(b.state, treeID)
	}
	return wasParked
}

// anyInFlight reports whether any tree is currently claimed (queued or being
// processed by a worker). A tree stays in-flight from claim until the worker
// resolves it via recordSuccess/recordFailure. Used by tests to know when a
// sync cycle has fully drained.
func (b *backoffTracker) anyInFlight() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, st := range b.state {
		if st.inFlight {
			return true
		}
	}
	return false
}

// parkedTrees returns the sorted ids of trees currently parked.
func (b *backoffTracker) parkedTrees() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []string
	for id, st := range b.state {
		if st.parked {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// syncWorkItem represents a single tree sync operation queued for a worker.
type syncWorkItem struct {
	treeId string
	peer   peer.Peer
	peerId string // peer ID to inject into fresh context (avoids stale DiffSyncer ctx)
}

// matouTreeSyncer implements treesyncer.TreeSyncer using persistent worker pools.
// HeadSync discovers missing/changed trees via diff, then matouTreeSyncer syncs
// them using the ObjectSync protocol. Worker pools are created in Init() and
// persist for the lifetime of the space, avoiding goroutine creation/destruction
// on each HeadSync cycle (~5 seconds).
type matouTreeSyncer struct {
	spaceId     string
	utm         *UnifiedTreeManager
	treeManager treeGetter

	// backoff gates re-queuing of persistently-failing missing trees (#129).
	backoff *backoffTracker

	// Persistent worker pools
	missingCh  chan syncWorkItem
	existingCh chan syncWorkItem
	wg         sync.WaitGroup
	closeOnce  sync.Once
}

func newMatouTreeSyncer(spaceId string, utm *UnifiedTreeManager) *matouTreeSyncer {
	return &matouTreeSyncer{
		spaceId:    spaceId,
		utm:        utm,
		backoff:    newBackoffTracker(),
		missingCh:  make(chan syncWorkItem, syncQueueSize),
		existingCh: make(chan syncWorkItem, syncQueueSize),
	}
}

func (t *matouTreeSyncer) Init(a *app.App) error {
	// Resolves to the objectManager in the child space app, which wraps
	// the parent app's UnifiedTreeManager. GetTree calls BuildSyncTreeOrGetRemote
	// which handles fetching missing trees from remote peers.
	t.treeManager = a.MustComponent(treemanager.CName).(treemanager.TreeManager)

	// Start persistent worker pools
	t.startWorkers()
	return nil
}

func (t *matouTreeSyncer) Name() string                  { return treesyncer.CName }
func (t *matouTreeSyncer) Run(ctx context.Context) error { return nil }

func (t *matouTreeSyncer) Close(ctx context.Context) error {
	t.closeOnce.Do(func() {
		close(t.missingCh)
		close(t.existingCh)
	})
	t.wg.Wait()
	return nil
}

// StartSync and StopSync are declared by the treesyncer.TreeSyncer interface
// but are never called by the any-sync SDK. Worker pools are managed by
// Init()/Close() instead.
func (t *matouTreeSyncer) StartSync()                    {}
func (t *matouTreeSyncer) StopSync()                     {}
func (t *matouTreeSyncer) ShouldSync(peerId string) bool { return true }

// startWorkers launches the persistent worker goroutines for both pools.
func (t *matouTreeSyncer) startWorkers() {
	// Missing tree workers — fetch full trees from remote peers
	for i := 0; i < missingTreeWorkers; i++ {
		t.wg.Add(1)
		go t.missingWorker()
	}

	// Existing tree workers — sync head updates
	for i := 0; i < existingTreeWorkers; i++ {
		t.wg.Add(1)
		go t.existingWorker()
	}
}

// missingWorker processes missing tree sync items from the channel.
func (t *matouTreeSyncer) missingWorker() {
	defer t.wg.Done()
	for item := range t.missingCh {
		log.Printf("[TreeSyncer] missingWorker: fetching tree %s in space %s from peer %s", item.treeId, t.spaceId, item.peerId)
		// Create a fresh context with the peer ID. The DiffSyncer's original context
		// is canceled when the sync cycle ends (~5s), but BuildSyncTreeOrGetRemote
		// needs a live context to fetch the tree from the remote peer.
		ctx := peer.CtxWithPeerId(context.Background(), item.peerId)
		tr, err := t.treeManager.GetTree(ctx, t.spaceId, item.treeId)
		if err != nil {
			t.recordMissingFailure(item.treeId, err)
			continue
		}
		log.Printf("[TreeSyncer] missingWorker: got tree %s, isSyncTree=%v", item.treeId, func() bool { _, ok := tr.(synctree.SyncTree); return ok }())

		// Update UTM index for the newly fetched tree so it appears in GetTreesForSpace
		if t.utm != nil {
			t.utm.IndexTree(tr, t.spaceId, item.treeId)
		}

		if st, ok := tr.(synctree.SyncTree); ok {
			if err := st.SyncWithPeer(ctx, item.peer); err != nil {
				t.recordMissingFailure(item.treeId, err)
				continue
			}
			log.Printf("[TreeSyncer] missingWorker: SyncWithPeer OK for tree %s", item.treeId)
		}

		if t.backoff.recordSuccess(item.treeId) {
			log.Printf("[TreeSyncer] missingWorker: tree %s recovered, resuming normal sync", item.treeId)
		}
	}
}

// recordMissingFailure updates the per-tree backoff after a failed fetch/sync of
// a missing tree and logs proportionally: a per-failure ERROR while the tree is
// still retrying quickly, a single "parked" line when it crosses the failure
// cap, then silence until it recovers (see #129).
func (t *matouTreeSyncer) recordMissingFailure(treeID string, cause error) {
	delay, justParked, parked := t.backoff.recordFailure(treeID)
	switch {
	case justParked:
		log.Printf("[TreeSyncer] missingWorker: tree %s parked after %d consecutive failures, retrying every %s (last error: %v)",
			treeID, parkThreshold, backoffMax, cause)
	case parked:
		// Already parked — stay quiet to keep the log from filling.
	default:
		log.Printf("[TreeSyncer] missingWorker: FAILED to get tree %s: %v (retry in %s)", treeID, cause, delay)
	}
}

// existingWorker processes existing tree sync items from the channel.
func (t *matouTreeSyncer) existingWorker() {
	defer t.wg.Done()
	for item := range t.existingCh {
		// Use a fresh context — the DiffSyncer's context may be canceled by the time
		// the worker picks up this item.
		ctx := peer.CtxWithPeerId(context.Background(), item.peerId)
		tr, err := t.treeManager.GetTree(ctx, t.spaceId, item.treeId)
		if err != nil {
			continue
		}
		if st, ok := tr.(synctree.SyncTree); ok {
			if err := st.SyncWithPeer(ctx, item.peer); err != nil {
				log.Printf("[TreeSyncer] Warning: failed to sync existing tree %s with peer %s: %v",
					item.treeId, item.peer.Id(), err)
			}
		}
	}
}

// SyncAll queues existing and missing trees for sync with a peer.
// Work items are dispatched to persistent worker pools created in Init().
//
// IMPORTANT: The ctx passed by DiffSyncer is tied to the sync cycle and gets
// canceled when syncWithPeer returns. Since our workers process items
// asynchronously, we must create detached contexts that preserve the peer ID
// but don't inherit the sync cycle's cancellation. Without this, workers see
// "context canceled" before they can fetch/sync trees.
func (t *matouTreeSyncer) SyncAll(ctx context.Context, p peer.Peer, existing, missing []string) error {
	if len(missing) > 0 || len(existing) > 0 {
		log.Printf("[TreeSyncer] SyncAll space=%s peer=%s missing=%d existing=%d", t.spaceId, p.Id(), len(missing), len(existing))
	}

	peerId := p.Id()

	// Queue missing trees for the missing-tree worker pool. HeadSync re-feeds the
	// same missing set every ~5s; the backoff tracker skips any tree still inside
	// its retry window (or already in flight) so a persistently-failing tree no
	// longer loops forever (#129).
	for _, id := range missing {
		if !t.backoff.claim(id) {
			continue
		}
		select {
		case t.missingCh <- syncWorkItem{treeId: id, peer: p, peerId: peerId}:
		case <-ctx.Done():
			t.backoff.release(id)
			return ctx.Err()
		}
	}

	// Queue existing trees for the existing-tree worker pool
	for _, id := range existing {
		select {
		case t.existingCh <- syncWorkItem{treeId: id, peer: p, peerId: peerId}:
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	return nil
}
