// Package anysync provides any-sync integration for MATOU.
// sync_status.go implements syncstatus.StatusUpdater for tracking sync state.
package anysync

import (
	"sync"

	"github.com/anyproto/any-sync/app"
	"github.com/anyproto/any-sync/commonspace/syncstatus"
)

// MatouSyncStatus implements syncstatus.StatusUpdater with actual tracking.
type MatouSyncStatus struct {
	mu       sync.RWMutex
	changed  map[string][]string // treeId → latest heads (from local changes)
	received map[string]int      // treeId → receive count
	applied  map[string]int      // treeId → apply count
}

func newMatouSyncStatus() *MatouSyncStatus {
	return &MatouSyncStatus{
		changed:  make(map[string][]string),
		received: make(map[string]int),
		applied:  make(map[string]int),
	}
}

// Init implements app.Component; MatouSyncStatus needs no app-level dependencies.
func (s *MatouSyncStatus) Init(_ *app.App) error { return nil }

// Name implements app.Component, returning the syncstatus component name.
func (s *MatouSyncStatus) Name() string { return syncstatus.CName }

// HeadsChange implements syncstatus.StatusUpdater, recording the latest heads
// produced by a local change to the given tree.
func (s *MatouSyncStatus) HeadsChange(treeID string, heads []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.changed[treeID] = heads
}

// HeadsReceive implements syncstatus.StatusUpdater, recording that heads were
// received for the given tree from a peer.
func (s *MatouSyncStatus) HeadsReceive(_, treeID string, _ []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.received[treeID]++
}

// ObjectReceive implements syncstatus.StatusUpdater, recording that an object
// was received for the given tree from a peer.
func (s *MatouSyncStatus) ObjectReceive(_, treeID string, _ []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.received[treeID]++
}

// HeadsApply implements syncstatus.StatusUpdater, recording that heads were
// applied to the given tree.
func (s *MatouSyncStatus) HeadsApply(_, treeID string, _ []string, _ bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.applied[treeID]++
}

// GetStatus returns a summary of sync activity.
func (s *MatouSyncStatus) GetStatus() (changed, received, applied int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	changed = len(s.changed)
	for _, v := range s.received {
		received += v
	}
	for _, v := range s.applied {
		applied += v
	}
	return
}
