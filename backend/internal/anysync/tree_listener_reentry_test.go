package anysync

import (
	"errors"
	"testing"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
)

// unreadableTree is a tree whose content cannot be decrypted, which is what
// every contribution and chat tree looks like to a backend that has no
// identity yet (it holds no read key for the community space).
type unreadableTree struct {
	objecttree.ObjectTree
}

func (unreadableTree) IterateRoot(objecttree.ChangeConvertFunc, objecttree.ChangeIterateFunc) error {
	return errors.New("no read key")
}

// A fresh-tree reader may build other trees with this same listener attached —
// any-sync calls Rebuild on every tree it builds. The listener used to hold its
// mutex across the reader, so that nested Rebuild locked it a second time on
// the same goroutine and never returned; every later tree build in every space
// then queued behind the mutex and sync stopped for the life of the process
// (#567).
func TestProcessChanges_FreshTreeReaderMayReenterTheListener(t *testing.T) {
	acl, owner, _ := twoWriterACL(t)
	unreadable := unreadableTree{newEncryptedTree(t, acl, owner, "ctr_1", TypeContribution)}
	other := newEncryptedTree(t, acl, owner, "ctr_2", TypeContribution)
	addOps(t, other, owner.Keys.SignKey, 1, true, ChangeOp{Op: "set", Field: "title", Value: []byte(`"x"`)})

	l := NewTreeUpdateListener(nil, nil)
	l.SetFreshTreeReader(func(string) (objecttree.ObjectTree, error) {
		if err := l.Rebuild(other); err != nil {
			t.Errorf("nested Rebuild: %v", err)
		}
		return nil, errors.New("not in storage")
	})

	done := make(chan error, 1)
	go func() { done <- l.Rebuild(unreadable) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Rebuild: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Rebuild never returned: the listener deadlocked on its own mutex")
	}

	// The listener must still be usable afterwards.
	again := make(chan error, 1)
	go func() { again <- l.Rebuild(other) }()
	select {
	case <-again:
	case <-time.After(5 * time.Second):
		t.Fatal("listener is wedged after the fallback")
	}
}
