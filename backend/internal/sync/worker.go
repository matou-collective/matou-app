package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/api"
)

// Chat sync is now handled by TreeUpdateListener (push-based via SyncTree).
// This worker only handles credential polling.

// WorkerConfig configures the background sync worker.
type WorkerConfig struct {
	// Interval between sync polls.
	Interval time.Duration
	// CommunitySpaceID to monitor for new credentials.
	CommunitySpaceID string
}

// DefaultConfig returns a default worker config.
func DefaultConfig() *WorkerConfig {
	return &WorkerConfig{
		Interval: 5 * time.Second,
	}
}

// Worker periodically syncs credentials from the AnySync community space
// and emits events for new/changed data.
type Worker struct {
	config       *WorkerConfig
	spaceManager *anysync.SpaceManager
	store        *anystore.LocalStore
	broker       *api.EventBroker

	mu         sync.RWMutex
	knownSAIDs map[string]bool
	cancel     context.CancelFunc
	done       chan struct{}
}

// NewWorker creates a new background sync worker.
func NewWorker(
	config *WorkerConfig,
	spaceManager *anysync.SpaceManager,
	store *anystore.LocalStore,
	broker *api.EventBroker,
) *Worker {
	return &Worker{
		config:       config,
		spaceManager: spaceManager,
		store:        store,
		broker:       broker,
		knownSAIDs:   make(map[string]bool),
	}
}

// Start begins the background sync loop.
func (w *Worker) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	w.cancel = cancel
	w.done = make(chan struct{})

	go w.run(ctx)
	fmt.Println("[SyncWorker] Started background sync worker")
}

// Stop gracefully shuts down the sync worker.
func (w *Worker) Stop() {
	if w.cancel != nil {
		w.cancel()
	}
	if w.done != nil {
		<-w.done
	}
	fmt.Println("[SyncWorker] Stopped background sync worker")
}

func (w *Worker) run(ctx context.Context) {
	defer close(w.done)

	// Initial sync
	w.syncOnce(ctx)

	ticker := time.NewTicker(w.config.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.syncOnce(ctx)
		}
	}
}

func (w *Worker) syncOnce(ctx context.Context) {
	communitySpaceID := w.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		return
	}

	// Only sync if there are SSE clients listening
	if w.broker.ClientCount() == 0 {
		return
	}

	treeMgr := w.spaceManager.CredentialTreeManager()
	if treeMgr == nil {
		return
	}

	creds, err := treeMgr.ReadCredentials(ctx, communitySpaceID)
	if err != nil {
		return
	}

	w.mu.Lock()
	defer w.mu.Unlock()

	for _, cred := range creds {
		if w.knownSAIDs[cred.SAID] {
			continue
		}
		w.knownSAIDs[cred.SAID] = true

		// Cache in anystore
		var data interface{}
		if cred.Data != nil {
			json.Unmarshal(cred.Data, &data)
		}

		cached := &anystore.CachedCredential{
			ID:         cred.SAID,
			IssuerAID:  cred.Issuer,
			SubjectAID: cred.Recipient,
			SchemaID:   cred.Schema,
			Data:       data,
			CachedAt:   time.Now().UTC(),
		}

		cacheCtx := context.Background()
		if storeErr := w.store.StoreCredential(cacheCtx, cached); storeErr != nil {
			fmt.Printf("[SyncWorker] Failed to cache credential %s: %v\n", cred.SAID, storeErr)
		}

		// Determine event type
		anysyncCred := &anysync.Credential{Schema: cred.Schema}
		eventType := "credential:new"
		if anysync.IsCommunityVisible(anysyncCred) {
			eventType = "credential:community"
		}

		// Broadcast event
		w.broker.Broadcast(api.SSEEvent{
			Type: eventType,
			Data: map[string]string{
				"said":      cred.SAID,
				"issuer":    cred.Issuer,
				"recipient": cred.Recipient,
				"schema":    cred.Schema,
			},
		})
	}

}
