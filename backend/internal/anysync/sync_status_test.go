package anysync

import (
	"testing"

	"github.com/anyproto/any-sync/commonspace/syncstatus"
)

func TestMatouSyncStatus_Name(t *testing.T) {
	ss := newMatouSyncStatus()
	if ss.Name() != syncstatus.CName {
		t.Errorf("expected CName %s, got %s", syncstatus.CName, ss.Name())
	}
}

func TestMatouSyncStatus_Init(t *testing.T) {
	ss := newMatouSyncStatus()
	if err := ss.Init(nil); err != nil {
		t.Errorf("Init should return nil: %v", err)
	}
}

func TestMatouSyncStatus_HeadsChange(t *testing.T) {
	ss := newMatouSyncStatus()
	ss.HeadsChange("tree-1", []string{"head-a", "head-b"})

	changed, received, applied := ss.GetStatus()
	if changed != 1 {
		t.Errorf("expected 1 changed tree, got %d", changed)
	}
	if received != 0 {
		t.Errorf("expected 0 received, got %d", received)
	}
	if applied != 0 {
		t.Errorf("expected 0 applied, got %d", applied)
	}
}

func TestMatouSyncStatus_HeadsReceive(t *testing.T) {
	ss := newMatouSyncStatus()
	ss.HeadsReceive("peer-1", "tree-1", []string{"head-a"})
	ss.HeadsReceive("peer-2", "tree-1", []string{"head-b"})

	_, received, _ := ss.GetStatus()
	if received != 2 {
		t.Errorf("expected 2 receives, got %d", received)
	}
}

func TestMatouSyncStatus_ObjectReceive(t *testing.T) {
	ss := newMatouSyncStatus()
	ss.ObjectReceive("peer-1", "tree-1", []string{"head-a"})

	_, received, _ := ss.GetStatus()
	if received != 1 {
		t.Errorf("expected 1 receive, got %d", received)
	}
}

func TestMatouSyncStatus_HeadsApply(t *testing.T) {
	ss := newMatouSyncStatus()
	ss.HeadsApply("peer-1", "tree-1", []string{"head-a"}, true)
	ss.HeadsApply("peer-1", "tree-2", []string{"head-b"}, false)

	_, _, applied := ss.GetStatus()
	if applied != 2 {
		t.Errorf("expected 2 applied, got %d", applied)
	}
}

func TestMatouSyncStatus_FullActivity(t *testing.T) {
	ss := newMatouSyncStatus()

	// Simulate realistic sync activity
	ss.HeadsChange("tree-1", []string{"h1"})
	ss.HeadsChange("tree-2", []string{"h2"})
	ss.HeadsReceive("peer-1", "tree-1", []string{"h1"})
	ss.ObjectReceive("peer-1", "tree-3", []string{"h3"})
	ss.HeadsApply("peer-1", "tree-1", []string{"h1"}, true)

	changed, received, applied := ss.GetStatus()
	if changed != 2 {
		t.Errorf("expected 2 changed, got %d", changed)
	}
	if received != 2 {
		t.Errorf("expected 2 received, got %d", received)
	}
	if applied != 1 {
		t.Errorf("expected 1 applied, got %d", applied)
	}
}

func TestMatouSyncStatus_HeadsChangeOverwrite(t *testing.T) {
	ss := newMatouSyncStatus()

	// Same tree gets multiple head changes — should overwrite, not accumulate
	ss.HeadsChange("tree-1", []string{"h1"})
	ss.HeadsChange("tree-1", []string{"h2"})
	ss.HeadsChange("tree-1", []string{"h3"})

	changed, _, _ := ss.GetStatus()
	if changed != 1 {
		t.Errorf("expected 1 changed tree (overwritten), got %d", changed)
	}
}
