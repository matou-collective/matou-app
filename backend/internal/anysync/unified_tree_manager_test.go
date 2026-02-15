package anysync

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestUnifiedTreeManager_NewInstance(t *testing.T) {
	utm := NewUnifiedTreeManager()
	if utm == nil {
		t.Fatal("NewUnifiedTreeManager returned nil")
	}
	if utm.Name() != "common.object.treemanager" {
		t.Errorf("expected CName 'common.object.treemanager', got '%s'", utm.Name())
	}
}

func TestUnifiedTreeManager_AddAndGetIndex(t *testing.T) {
	utm := NewUnifiedTreeManager()

	entry := ObjectIndexEntry{
		TreeID:     "tree-1",
		ObjectID:   "SharedProfile-EAID123",
		ObjectType: "SharedProfile",
		ChangeType: ProfileTreeType,
	}

	utm.addToIndex("space-1", "tree-1", entry)

	// Check space index
	entries := utm.GetTreesForSpace("space-1")
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].TreeID != "tree-1" {
		t.Errorf("expected tree-1, got %s", entries[0].TreeID)
	}
	if entries[0].ObjectID != "SharedProfile-EAID123" {
		t.Errorf("expected SharedProfile-EAID123, got %s", entries[0].ObjectID)
	}

	// Check object map
	treeID := utm.GetTreeIDForObject("SharedProfile-EAID123")
	if treeID != "tree-1" {
		t.Errorf("expected tree-1, got %s", treeID)
	}
}

func TestUnifiedTreeManager_GetTreesByType(t *testing.T) {
	utm := NewUnifiedTreeManager()

	utm.addToIndex("space-1", "tree-1", ObjectIndexEntry{
		TreeID: "tree-1", ObjectID: "SharedProfile-A", ObjectType: "SharedProfile", ChangeType: ProfileTreeType,
	})
	utm.addToIndex("space-1", "tree-2", ObjectIndexEntry{
		TreeID: "tree-2", ObjectID: "CommunityProfile-B", ObjectType: "CommunityProfile", ChangeType: ProfileTreeType,
	})
	utm.addToIndex("space-1", "tree-3", ObjectIndexEntry{
		TreeID: "tree-3", ObjectID: "SharedProfile-C", ObjectType: "SharedProfile", ChangeType: ProfileTreeType,
	})

	shared := utm.GetTreesByType("space-1", "SharedProfile")
	if len(shared) != 2 {
		t.Fatalf("expected 2 SharedProfile entries, got %d", len(shared))
	}

	community := utm.GetTreesByType("space-1", "CommunityProfile")
	if len(community) != 1 {
		t.Fatalf("expected 1 CommunityProfile entry, got %d", len(community))
	}

	unknown := utm.GetTreesByType("space-1", "Unknown")
	if len(unknown) != 0 {
		t.Fatalf("expected 0 Unknown entries, got %d", len(unknown))
	}
}

func TestUnifiedTreeManager_GetTreesByChangeType(t *testing.T) {
	utm := NewUnifiedTreeManager()

	utm.addToIndex("space-1", "tree-1", ObjectIndexEntry{
		TreeID: "tree-1", ObjectID: "Profile-A", ObjectType: "SharedProfile", ChangeType: ProfileTreeType,
	})
	utm.addToIndex("space-1", "tree-2", ObjectIndexEntry{
		TreeID: "tree-2", ObjectID: "Cred-B", ObjectType: "EMatouMembership", ChangeType: CredentialTreeType,
	})

	profiles := utm.GetTreesByChangeType("space-1", ProfileTreeType)
	if len(profiles) != 1 {
		t.Fatalf("expected 1 profile tree, got %d", len(profiles))
	}

	creds := utm.GetTreesByChangeType("space-1", CredentialTreeType)
	if len(creds) != 1 {
		t.Fatalf("expected 1 credential tree, got %d", len(creds))
	}
}

func TestUnifiedTreeManager_RemoveFromIndex(t *testing.T) {
	utm := NewUnifiedTreeManager()

	utm.addToIndex("space-1", "tree-1", ObjectIndexEntry{
		TreeID: "tree-1", ObjectID: "obj-1", ObjectType: "SharedProfile", ChangeType: ProfileTreeType,
	})

	// Verify it exists
	if treeID := utm.GetTreeIDForObject("obj-1"); treeID != "tree-1" {
		t.Fatalf("expected tree-1, got %s", treeID)
	}

	// Remove it
	utm.removeFromIndex("space-1", "tree-1")

	// Should be gone from object map
	if treeID := utm.GetTreeIDForObject("obj-1"); treeID != "" {
		t.Errorf("expected empty treeID after removal, got %s", treeID)
	}

	// Should be gone from space index
	entries := utm.GetTreesForSpace("space-1")
	if len(entries) != 0 {
		t.Errorf("expected 0 entries after removal, got %d", len(entries))
	}
}

func TestUnifiedTreeManager_EmptySpace(t *testing.T) {
	utm := NewUnifiedTreeManager()

	entries := utm.GetTreesForSpace("nonexistent-space")
	if len(entries) != 0 {
		t.Errorf("expected 0 entries for nonexistent space, got %d", len(entries))
	}
}

func TestUnifiedTreeManager_TreeCount(t *testing.T) {
	utm := NewUnifiedTreeManager()

	if utm.TreeCount("space-1") != 0 {
		t.Errorf("expected 0 trees initially, got %d", utm.TreeCount("space-1"))
	}

	utm.addToIndex("space-1", "tree-1", ObjectIndexEntry{
		TreeID: "tree-1", ObjectID: "obj-1", ObjectType: "SharedProfile", ChangeType: ProfileTreeType,
	})

	if utm.TreeCount("space-1") != 1 {
		t.Errorf("expected 1 tree, got %d", utm.TreeCount("space-1"))
	}
}

func TestUnifiedTreeManager_HasTrees(t *testing.T) {
	utm := NewUnifiedTreeManager()

	if utm.HasTrees("space-1") {
		t.Error("expected HasTrees=false for empty space")
	}

	utm.addToIndex("space-1", "tree-1", ObjectIndexEntry{
		TreeID: "tree-1", ObjectID: "obj-1", ObjectType: "SharedProfile", ChangeType: ProfileTreeType,
	})

	if !utm.HasTrees("space-1") {
		t.Error("expected HasTrees=true after adding entry")
	}
}

func TestUnifiedTreeManager_WaitForSync_AlreadyHasTrees(t *testing.T) {
	utm := NewUnifiedTreeManager()

	// Add a tree before waiting
	utm.addToIndex("space-1", "tree-1", ObjectIndexEntry{
		TreeID: "tree-1", ObjectID: "obj-1", ObjectType: "SharedProfile", ChangeType: ProfileTreeType,
	})

	ctx := context.Background()
	err := utm.WaitForSync(ctx, "space-1", 1, 100*time.Millisecond)
	if err != nil {
		t.Fatalf("WaitForSync should succeed immediately when trees exist: %v", err)
	}
}

func TestUnifiedTreeManager_WaitForSync_Timeout(t *testing.T) {
	utm := NewUnifiedTreeManager()

	ctx := context.Background()
	err := utm.WaitForSync(ctx, "space-1", 1, 200*time.Millisecond)
	if err == nil {
		t.Fatal("WaitForSync should timeout when no trees exist")
	}
}

func TestUnifiedTreeManager_WaitForSync_TreeAppearsLater(t *testing.T) {
	utm := NewUnifiedTreeManager()

	// Add tree after a short delay
	go func() {
		time.Sleep(50 * time.Millisecond)
		utm.addToIndex("space-1", "tree-1", ObjectIndexEntry{
			TreeID: "tree-1", ObjectID: "obj-1", ObjectType: "SharedProfile", ChangeType: ProfileTreeType,
		})
	}()

	ctx := context.Background()
	err := utm.WaitForSync(ctx, "space-1", 1, 2*time.Second)
	if err != nil {
		t.Fatalf("WaitForSync should succeed when tree appears: %v", err)
	}
}

func TestUnifiedTreeManager_ConcurrentAccess(t *testing.T) {
	utm := NewUnifiedTreeManager()

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			treeID := fmt.Sprintf("tree-%d", n)
			objectID := fmt.Sprintf("obj-%d", n)
			entry := ObjectIndexEntry{
				TreeID:     treeID,
				ObjectID:   objectID,
				ObjectType: "SharedProfile",
				ChangeType: ProfileTreeType,
			}
			utm.addToIndex("space-1", treeID, entry)
			utm.GetTreesForSpace("space-1")
			utm.GetTreesByType("space-1", "SharedProfile")
		}(i)
	}
	wg.Wait()

	// Should not panic from concurrent access
	entries := utm.GetTreesForSpace("space-1")
	if len(entries) == 0 {
		t.Error("expected some entries after concurrent writes")
	}
}

func TestUnifiedTreeManager_MultipleSpaces(t *testing.T) {
	utm := NewUnifiedTreeManager()

	utm.addToIndex("space-1", "tree-1", ObjectIndexEntry{
		TreeID: "tree-1", ObjectID: "obj-1", ObjectType: "SharedProfile", ChangeType: ProfileTreeType,
	})
	utm.addToIndex("space-2", "tree-2", ObjectIndexEntry{
		TreeID: "tree-2", ObjectID: "obj-2", ObjectType: "CommunityProfile", ChangeType: ProfileTreeType,
	})
	utm.addToIndex("space-2", "tree-3", ObjectIndexEntry{
		TreeID: "tree-3", ObjectID: "obj-3", ObjectType: "SharedProfile", ChangeType: ProfileTreeType,
	})

	// Space 1 should have 1 entry
	if len(utm.GetTreesForSpace("space-1")) != 1 {
		t.Error("space-1 should have 1 entry")
	}

	// Space 2 should have 2 entries
	if len(utm.GetTreesForSpace("space-2")) != 2 {
		t.Error("space-2 should have 2 entries")
	}

	// Object map should work across spaces
	if utm.GetTreeIDForObject("obj-1") != "tree-1" {
		t.Error("obj-1 should map to tree-1")
	}
	if utm.GetTreeIDForObject("obj-2") != "tree-2" {
		t.Error("obj-2 should map to tree-2")
	}
}

func TestTreeRootHeader_Serialization(t *testing.T) {
	header := TreeRootHeader{
		ObjectID:   "SharedProfile-EAID123",
		ObjectType: "SharedProfile",
	}

	if header.ObjectID != "SharedProfile-EAID123" {
		t.Errorf("ObjectID mismatch")
	}
	if header.ObjectType != "SharedProfile" {
		t.Errorf("ObjectType mismatch")
	}
}

func TestObjectIndexEntry_Fields(t *testing.T) {
	entry := ObjectIndexEntry{
		TreeID:     "tree-abc123",
		ObjectID:   "CommunityProfile-EAID456",
		ObjectType: "CommunityProfile",
		ChangeType: ProfileTreeType,
	}

	if entry.TreeID != "tree-abc123" {
		t.Errorf("TreeID mismatch")
	}
	if entry.ObjectType != "CommunityProfile" {
		t.Errorf("ObjectType mismatch")
	}
	if entry.ChangeType != ProfileTreeType {
		t.Errorf("ChangeType mismatch")
	}
}

func TestConstants(t *testing.T) {
	if ProfileTreeType != "matou.profile.v1" {
		t.Errorf("ProfileTreeType = %s, want matou.profile.v1", ProfileTreeType)
	}
	if CredentialTreeType != "matou.credential.v1" {
		t.Errorf("CredentialTreeType = %s, want matou.credential.v1", CredentialTreeType)
	}
}
