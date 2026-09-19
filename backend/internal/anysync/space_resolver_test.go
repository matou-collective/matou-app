// Package anysync tests for the shared space resolver's lifecycle (#567).
package anysync

import (
	"errors"
	"sync/atomic"
	"testing"

	"github.com/anyproto/any-sync/commonspace"
)

// fakeSpace embeds commonspace.Space so it satisfies the interface with only
// Close overridden — CloseAll never touches the other methods. Close records how
// many times it was invoked (Space.Close is expected to be idempotent).
type fakeSpace struct {
	commonspace.Space
	closes   int32
	closeErr error
}

func (f *fakeSpace) Close() error {
	atomic.AddInt32(&f.closes, 1)
	return f.closeErr
}

// TestSpaceResolverCloseAllClosesCachedSpaces asserts CloseAll closes every
// cached space and empties the cache. Before #567 Reinitialize/Close simply
// dropped the resolver's cache without closing the spaces, so the pre-teardown
// spaces kept their own HeadSync loop and tree-syncer workers running.
func TestSpaceResolverCloseAllClosesCachedSpaces(t *testing.T) {
	r := newSDKSpaceResolver()
	s1 := &fakeSpace{}
	s2 := &fakeSpace{}
	r.StoreSpace("space-1", s1)
	r.StoreSpace("space-2", s2)

	if err := r.CloseAll(); err != nil {
		t.Fatalf("CloseAll returned error: %v", err)
	}
	if got := atomic.LoadInt32(&s1.closes); got != 1 {
		t.Fatalf("space-1 Close called %d times, want 1", got)
	}
	if got := atomic.LoadInt32(&s2.closes); got != 1 {
		t.Fatalf("space-2 Close called %d times, want 1", got)
	}

	// Cache must be empty afterwards: a second CloseAll closes nothing.
	if err := r.CloseAll(); err != nil {
		t.Fatalf("second CloseAll returned error: %v", err)
	}
	if got := atomic.LoadInt32(&s1.closes); got != 1 {
		t.Fatalf("space-1 Close called %d times after clear, want 1", got)
	}
}

// TestSpaceResolverCloseAllAggregatesErrors ensures a failing Close does not stop
// the others from being closed and that the error is surfaced.
func TestSpaceResolverCloseAllAggregatesErrors(t *testing.T) {
	r := newSDKSpaceResolver()
	bad := &fakeSpace{closeErr: errors.New("boom")}
	good := &fakeSpace{}
	r.StoreSpace("bad", bad)
	r.StoreSpace("good", good)

	err := r.CloseAll()
	if err == nil {
		t.Fatal("CloseAll should surface the failing space's error")
	}
	if got := atomic.LoadInt32(&good.closes); got != 1 {
		t.Fatalf("good space Close called %d times, want 1 (one failure must not skip others)", got)
	}
}
