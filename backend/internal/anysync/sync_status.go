// Package anysync provides any-sync integration for MATOU.
// sync_status.go implements syncstatus.StatusUpdater for tracking sync state.
package anysync

import (
	"sync"

	"github.com/anyproto/any-sync/app"
	"github.com/anyproto/any-sync/commonspace/syncstatus"
)

// matouSyncStatus implements syncstatus.StatusUpdater with actual tracking.
type matouSyncStatus struct {
	mu       sync.RWMutex
	changed  map[string][]string // treeId → latest heads (from local changes)
	received map[string]int      // treeId → receive count
	applied  map[string]int      // treeId → apply count
}

func newMatouSyncStatus() *matouSyncStatus {
	return &matouSyncStatus{
		changed:  make(map[string][]string),
		received: make(map[string]int),
		applied:  make(map[string]int),
	}
}

func (s *matouSyncStatus) Init(a *app.App) error { return nil }
func (s *matouSyncStatus) Name() string          { return syncstatus.CName }

func (s *matouSyncStatus) HeadsChange(treeId string, heads []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.changed[treeId] = heads
}

func (s *matouSyncStatus) HeadsReceive(senderId, treeId string, heads []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.received[treeId]++
}

func (s *matouSyncStatus) ObjectReceive(senderId, treeId string, heads []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.received[treeId]++
}

func (s *matouSyncStatus) HeadsApply(senderId, treeId string, heads []string, allAdded bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.applied[treeId]++
}

// GetStatus returns a summary of sync activity.
func (s *matouSyncStatus) GetStatus() (changed, received, applied int) {
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
