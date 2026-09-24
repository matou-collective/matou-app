package anysync

import "testing"

func TestSpaceHoldingTree(t *testing.T) {
	stores := func(held ...string) func(string) bool {
		return func(spaceID string) bool {
			for _, h := range held {
				if h == spaceID {
					return true
				}
			}
			return false
		}
	}
	probed := func(t *testing.T) func(string) bool {
		return func(spaceID string) bool {
			t.Fatalf("probed storage of %s although the index already knew the space", spaceID)
			return false
		}
	}

	t.Run("the index wins without touching storage", func(t *testing.T) {
		if got := spaceHoldingTree("space-indexed", []string{"space-a"}, probed(t)); got != "space-indexed" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("an unindexed tree is found in the open space that stores it", func(t *testing.T) {
		// The listener fires before GetTree indexes the tree, and a space that
		// has just been opened has nothing indexed at all (#570).
		if got := spaceHoldingTree("", []string{"space-a", "space-new"}, stores("space-new")); got != "space-new" {
			t.Fatalf("got %q, want space-new", got)
		}
	})
	t.Run("no space holds it", func(t *testing.T) {
		if got := spaceHoldingTree("", []string{"space-a"}, stores()); got != "" {
			t.Fatalf("got %q, want none", got)
		}
	})
}

func TestSpaceResolverSpaceIDs_ListsOpenSpaces(t *testing.T) {
	r := newSDKSpaceResolver()
	r.StoreSpace("space-a", &closableSpace{})
	r.StoreSpace("space-b", &closableSpace{})
	got := r.spaceIDs()
	if len(got) != 2 {
		t.Fatalf("spaceIDs = %v, want the two open spaces", got)
	}
}
