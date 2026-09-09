package anysync

import (
	"context"
	"testing"
)

// readkey.go (#469 slice S2, spec §3.6) had zero test coverage: neither
// spaceReadKeyAvailable's guard clauses nor SpaceManager.SpaceReadKeyReady's
// nil-client / GetSpace-error paths were exercised. Those are exactly the
// paths a linked/recovered device hits before its read key arrives, so a
// broken guard (e.g. a flipped boolean) would silently report "ok" for a
// space that cannot actually be read. Building a real *list.AclState with a
// delivered read key needs the full ACL consensus-record harness (see
// acltestsuite.go), which is out of scope here; the "ok" path stays covered
// by go test ./... integration paths and live verification per the PR.

func TestSpaceReadKeyAvailable_NilSpace(t *testing.T) {
	if spaceReadKeyAvailable(nil) {
		t.Error("spaceReadKeyAvailable(nil) should be false — a nil space cannot be read")
	}
}

func TestSpaceManager_SpaceReadKeyReady_NilClient(t *testing.T) {
	// A zero-value SpaceManager (never wired to a client) — NewSpaceManager
	// itself requires a non-nil client (it calls client.GetPool()), so this
	// exercises SpaceReadKeyReady's own defensive nil check directly.
	manager := &SpaceManager{}
	if manager.SpaceReadKeyReady(context.Background(), "space-1") {
		t.Error("SpaceReadKeyReady should be false when the SpaceManager has no client — treat as pending, not ok")
	}
}

func TestSpaceManager_SpaceReadKeyReady_GetSpaceError(t *testing.T) {
	mockClient := newMockAnySyncClient() // GetSpace always errors by default
	manager := NewSpaceManager(mockClient, &SpaceManagerConfig{})
	if manager.SpaceReadKeyReady(context.Background(), "space-1") {
		t.Error("SpaceReadKeyReady should be false when GetSpace fails — space not yet reachable means access is pending, not ok")
	}
}
