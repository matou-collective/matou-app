package anysync

import (
	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
)

// PreloadObjectTree stores a mock tree in the UnifiedTreeManager's cache and index.
// This allows test packages to bypass GetSpace/discovery.
func PreloadObjectTree(mgr *ObjectTreeManager, spaceID, objectID, objectType string, tree objecttree.ObjectTree) {
	treeID := tree.Id()
	utm := mgr.treeManager
	utm.trees.Store(treeID, tree)
	utm.addToIndex(spaceID, treeID, ObjectIndexEntry{
		TreeID:     treeID,
		ObjectID:   objectID,
		ObjectType: objectType,
		ChangeType: ChatTreeType,
	})
}
