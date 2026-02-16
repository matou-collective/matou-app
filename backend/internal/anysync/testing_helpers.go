package anysync

import (
	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
)

// PreloadObjectTree stores a mock tree in an ObjectTreeManager's
// cache. This allows test packages to bypass GetSpace/discovery.
func PreloadObjectTree(mgr *ObjectTreeManager, spaceID string, tree objecttree.ObjectTree) {
	mgr.trees.Store(spaceID, tree)
}
