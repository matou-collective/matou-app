package anysync

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/anyproto/any-sync/commonspace"
)

type closableSpace struct {
	commonspace.Space
	closed atomic.Bool
	hang   chan struct{} // non-nil: Close blocks until it is closed
}

func (s *closableSpace) Close() error {
	if s.hang != nil {
		<-s.hang
	}
	s.closed.Store(true)
	return nil
}

// Reinitialize used to drop the resolver with its spaces still running: each
// kept a HeadSync loop (with no peers) and its worker pool for the life of the
// process (#570).
func TestSpaceResolverCloseSpaces_ClosesEveryCachedSpace(t *testing.T) {
	r := newSDKSpaceResolver()
	a, b := &closableSpace{}, &closableSpace{}
	r.StoreSpace("space-a", a)
	r.StoreSpace("space-b", b)

	r.closeSpaces(time.Second)

	if !a.closed.Load() || !b.closed.Load() {
		t.Fatalf("closed: a=%v b=%v, want both", a.closed.Load(), b.closed.Load())
	}
	if _, ok := r.cache.Load("space-a"); ok {
		t.Fatal("a closed space is still served from the cache")
	}
}

// One space that will not close must not hold up sign-in, nor the others.
func TestSpaceResolverCloseSpaces_DoesNotWaitForeverOnOneSpace(t *testing.T) {
	r := newSDKSpaceResolver()
	stuck := &closableSpace{hang: make(chan struct{})}
	defer close(stuck.hang)
	fine := &closableSpace{}
	r.StoreSpace("space-stuck", stuck)
	r.StoreSpace("space-fine", fine)

	done := make(chan struct{})
	go func() { r.closeSpaces(100 * time.Millisecond); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("closeSpaces is waiting on a space that will not close")
	}
	if !fine.closed.Load() {
		t.Fatal("the healthy space was not closed")
	}
}
