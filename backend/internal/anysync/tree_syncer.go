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
	"sync"

	"github.com/anyproto/any-sync/app"
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
)

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
	treeManager treemanager.TreeManager

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
			log.Printf("[TreeSyncer] missingWorker: FAILED to get tree %s: %v", item.treeId, err)
			continue
		}
		log.Printf("[TreeSyncer] missingWorker: got tree %s, isSyncTree=%v", item.treeId, func() bool { _, ok := tr.(synctree.SyncTree); return ok }())

		// Update UTM index for the newly fetched tree so it appears in GetTreesForSpace
		if t.utm != nil {
			t.utm.IndexTree(tr, t.spaceId, item.treeId)
		}

		if st, ok := tr.(synctree.SyncTree); ok {
			if err := st.SyncWithPeer(ctx, item.peer); err != nil {
				log.Printf("[TreeSyncer] missingWorker: SyncWithPeer failed for tree %s: %v", item.treeId, err)
			} else {
				log.Printf("[TreeSyncer] missingWorker: SyncWithPeer OK for tree %s", item.treeId)
			}
		}
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

	// Queue missing trees for the missing-tree worker pool
	for _, id := range missing {
		select {
		case t.missingCh <- syncWorkItem{treeId: id, peer: p, peerId: peerId}:
		case <-ctx.Done():
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
