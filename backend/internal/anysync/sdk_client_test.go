package anysync

import (
	"errors"
	"sort"
	"testing"

	"github.com/anyproto/any-sync/commonspace/mock_commonspace"
	"go.uber.org/mock/gomock"
)

// TestSpaceResolverCloseAll asserts that every Space handed out by the resolver
// has Close() called exactly once and is dropped from the cache. This is the
// mechanism SDKClient.Reinitialize and SDKClient.Close use (via closeCachedSpaces)
// to stop each space's sync services before the parent app is torn down, instead
// of leaking an orphan HeadSync loop per space (#570 item 1).
func TestSpaceResolverCloseAll(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	r := newSDKSpaceResolver()

	s1 := mock_commonspace.NewMockSpace(ctrl)
	s1.EXPECT().Close().Return(nil).Times(1)
	s2 := mock_commonspace.NewMockSpace(ctrl)
	s2.EXPECT().Close().Return(nil).Times(1)

	r.StoreSpace("space-1", s1)
	r.StoreSpace("space-2", s2)

	// Sanity: both spaces are open before CloseAll.
	if got := r.OpenSpaceIDs(); len(got) != 2 {
		t.Fatalf("expected 2 open spaces before CloseAll, got %v", got)
	}

	if err := r.CloseAll(); err != nil {
		t.Fatalf("CloseAll returned error: %v", err)
	}

	// The cache is cleared, so no orphan space remains to keep syncing.
	if got := r.OpenSpaceIDs(); len(got) != 0 {
		t.Fatalf("cache not cleared after CloseAll: %v", got)
	}
}

// TestSpaceResolverCloseAllAggregatesErrors asserts a per-space Close failure is
// surfaced but does not stop the other spaces from being closed — teardown must
// be best-effort across all cached spaces.
func TestSpaceResolverCloseAllAggregatesErrors(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	r := newSDKSpaceResolver()

	boom := errors.New("close boom")
	s1 := mock_commonspace.NewMockSpace(ctrl)
	s1.EXPECT().Close().Return(boom).Times(1)
	s2 := mock_commonspace.NewMockSpace(ctrl)
	s2.EXPECT().Close().Return(nil).Times(1)

	r.StoreSpace("space-1", s1)
	r.StoreSpace("space-2", s2)

	err := r.CloseAll()
	if err == nil || !errors.Is(err, boom) {
		t.Fatalf("expected aggregated error to include the close failure, got %v", err)
	}
	if got := r.OpenSpaceIDs(); len(got) != 0 {
		t.Fatalf("cache not cleared after CloseAll: %v", got)
	}
}

// TestSpaceResolverOpenSpaceIDs asserts OpenSpaceIDs enumerates the cached
// spaces — the accessor the fresh-tree fallback uses to probe open-but-unindexed
// spaces (#570 item 5).
func TestSpaceResolverOpenSpaceIDs(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	r := newSDKSpaceResolver()
	r.StoreSpace("space-b", mock_commonspace.NewMockSpace(ctrl))
	r.StoreSpace("space-a", mock_commonspace.NewMockSpace(ctrl))

	got := r.OpenSpaceIDs()
	sort.Strings(got)
	if len(got) != 2 || got[0] != "space-a" || got[1] != "space-b" {
		t.Fatalf("OpenSpaceIDs = %v, want [space-a space-b]", got)
	}
}
