// Package anysync provides any-sync integration for MATOU.
// unified_tree_manager.go provides a single source of truth for all tree instances,
// replacing both the sdkTreeManager cache (keyed by treeId) and TreeCache (keyed by spaceId).
// It implements treemanager.TreeManager for the any-sync component system and adds
// application-level methods for tree-per-object management.
package anysync

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/anyproto/any-sync/app"
	"github.com/anyproto/any-sync/commonspace"
	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/commonspace/object/tree/synctree/updatelistener"
	"github.com/anyproto/any-sync/commonspace/object/tree/treechangeproto"
	"github.com/anyproto/any-sync/commonspace/object/tree/treestorage"
	"github.com/anyproto/any-sync/commonspace/objecttreebuilder"
	"github.com/anyproto/any-sync/util/crypto"
)

// Tree type constants used as ChangeType on tree roots.
const (
	ProfileTreeType    = "matou.profile.v1"    // ChangeType on profile tree roots
	CredentialTreeType = "matou.credential.v1" // ChangeType on credential tree roots
	ChatTreeType       = "matou.chat.v1"       // ChangeType on chat tree roots
)

// TreeRootHeader is stored in the root change's ChangePayload (unencrypted metadata).
// This allows BuildSpaceIndex to identify trees without decrypting content.
type TreeRootHeader struct {
	ObjectID   string `json:"objectId"`
	ObjectType string `json:"objectType"`
}

// ObjectIndexEntry tracks a tree's metadata in the space index.
type ObjectIndexEntry struct {
	TreeID     string // any-sync tree ID
	ObjectID   string // e.g. "SharedProfile-EAbcd..."
	ObjectType string // e.g. "SharedProfile", "CommunityProfile"
	ChangeType string // root change type: "matou.profile.v1" or "matou.credential.v1"
}

// TestTreeFactory creates a mock tree for test use.
type TestTreeFactory func(objectID string) objecttree.ObjectTree

// UnifiedTreeManager is the single source of truth for all tree instances.
// It replaces both sdkTreeManager.cache (keyed by treeId) and TreeCache (keyed by spaceId).
// Implements treemanager.TreeManager interface (CName: "common.object.treemanager").
type UnifiedTreeManager struct {
	trees         sync.Map // treeId → objecttree.ObjectTree (THE single cache)
	spaceIndex    sync.Map // spaceId → *sync.Map[treeId → ObjectIndexEntry]
	objectMap     sync.Map // objectId → treeId (fast lookup by object ID)
	syncStatus    sync.Map // spaceId → *matouSyncStatus (per-space sync metrics)
	a             *app.App
	listener      updatelistener.UpdateListener
	testFactories sync.Map // spaceId → TestTreeFactory (test-only)
}

// NewUnifiedTreeManager creates a new UnifiedTreeManager.
func NewUnifiedTreeManager() *UnifiedTreeManager {
	return &UnifiedTreeManager{}
}

// --- treemanager.TreeManager interface ---

func (u *UnifiedTreeManager) Init(a *app.App) error {
	u.a = a
	return nil
}

func (u *UnifiedTreeManager) Name() string                    { return "common.object.treemanager" }
func (u *UnifiedTreeManager) Run(ctx context.Context) error   { return nil }
func (u *UnifiedTreeManager) Close(ctx context.Context) error { return nil }

// SetListener sets the UpdateListener that will be passed to BuildTree/PutTree
// for push-based P2P change notification.
func (u *UnifiedTreeManager) SetListener(l updatelistener.UpdateListener) {
	u.listener = l
}

// SetTestTreeFactory registers a factory that creates mock trees for a space.
// Test-only: used to bypass getSpace/BuildTree in unit tests.
func (u *UnifiedTreeManager) SetTestTreeFactory(spaceID string, factory TestTreeFactory) {
	u.testFactories.Store(spaceID, factory)
}

func (u *UnifiedTreeManager) getSpace(ctx context.Context, spaceId string) (commonspace.Space, error) {
	resolver := u.a.MustComponent(spaceResolverCName).(*sdkSpaceResolver)
	return resolver.GetSpace(ctx, spaceId)
}

// GetTree builds a tree from storage each time it's called.
// We intentionally do NOT cache tree instances because the tree's internal
// decryption keys (ot.keys) are populated once during BuildTree from the ACL
// state at that moment. If the ACL wasn't fully synced when the tree was first
// built (common after JoinWithInvite), the cached tree would permanently lack
// read keys, causing "no read key" errors on IterateRoot. Building fresh
// ensures readKeysFromAclState always runs with the latest ACL state.
func (u *UnifiedTreeManager) GetTree(ctx context.Context, spaceId, treeId string) (objecttree.ObjectTree, error) {
	// In test mode (no app), check the cache directly.
	if u.a == nil {
		if cached, ok := u.trees.Load(treeId); ok {
			return cached.(objecttree.ObjectTree), nil
		}
		return nil, fmt.Errorf("tree %s not found (test mode)", treeId)
	}

	sp, err := u.getSpace(ctx, spaceId)
	if err != nil {
		log.Printf("[UTM] GetTree space=%s tree=%s getSpace error: %v", spaceId, treeId, err)
		return nil, err
	}

	tree, err := sp.TreeBuilder().BuildTree(ctx, treeId, objecttreebuilder.BuildTreeOpts{
		Listener: u.listener,
	})
	if err != nil {
		log.Printf("[UTM] GetTree space=%s tree=%s BuildTree error: %v", spaceId, treeId, err)
		return nil, fmt.Errorf("building tree %s: %w", treeId, err)
	}

	// Index newly discovered trees (e.g. fetched from remote peer by TreeSyncer).
	// This is idempotent — addToIndex is a no-op if already indexed.
	if entry := u.extractIndexEntry(tree, treeId); entry != nil {
		u.addToIndex(spaceId, treeId, *entry)
	}

	return tree, nil
}

// ValidateAndPutTree stores an incoming tree from sync and updates the index.
func (u *UnifiedTreeManager) ValidateAndPutTree(ctx context.Context, spaceId string, payload treestorage.TreeStorageCreatePayload) error {
	sp, err := u.getSpace(ctx, spaceId)
	if err != nil {
		return err
	}

	tree, err := sp.TreeBuilder().PutTree(ctx, payload, u.listener)
	if err != nil {
		return fmt.Errorf("putting tree in space %s: %w", spaceId, err)
	}

	treeId := tree.Id()
	u.trees.Store(treeId, tree)

	// Try to index the tree
	if entry := u.extractIndexEntry(tree, treeId); entry != nil {
		u.addToIndex(spaceId, treeId, *entry)
	}

	return nil
}

// MarkTreeDeleted marks a tree as deleted.
func (u *UnifiedTreeManager) MarkTreeDeleted(ctx context.Context, spaceId, treeId string) error {
	tree, err := u.GetTree(ctx, spaceId, treeId)
	if err != nil {
		return err
	}
	return tree.Delete()
}

// DeleteTree removes a tree from cache and storage.
func (u *UnifiedTreeManager) DeleteTree(ctx context.Context, spaceId, treeId string) error {
	tree, err := u.GetTree(ctx, spaceId, treeId)
	if err != nil {
		return err
	}
	if err := tree.Delete(); err != nil {
		return err
	}
	u.trees.Delete(treeId)
	u.removeFromIndex(spaceId, treeId)
	return nil
}

// --- Application-level methods ---

// CreateObjectTree creates a NEW tree for an object, registers in all indexes.
// Returns the tree, its ID, and any error.
func (u *UnifiedTreeManager) CreateObjectTree(
	ctx context.Context, spaceID, objectID, objectType, changeType string, signingKey crypto.PrivKey,
) (objecttree.ObjectTree, string, error) {
	// In test mode, check for a test factory before calling getSpace
	// (getSpace panics on nil u.a)
	if factory, ok := u.testFactories.Load(spaceID); ok {
		tree := factory.(TestTreeFactory)(objectID)
		treeID := tree.Id()
		u.trees.Store(treeID, tree)
		u.addToIndex(spaceID, treeID, ObjectIndexEntry{
			TreeID:     treeID,
			ObjectID:   objectID,
			ObjectType: objectType,
			ChangeType: changeType,
		})
		return tree, treeID, nil
	}

	sp, err := u.getSpace(ctx, spaceID)
	if err != nil {
		return nil, "", fmt.Errorf("getting space %s: %w", spaceID, err)
	}

	// Diagnostic: check ACL read key availability before creating tree
	acl := sp.Acl()
	acl.RLock()
	aclState := acl.AclState()
	curKeyID := aclState.CurrentReadKeyId()
	acctKey := aclState.AccountKey()
	keysMap := aclState.Keys()
	var keyInfo []string
	for k, v := range keysMap {
		hasRK := v.ReadKey != nil
		keyInfo = append(keyInfo, fmt.Sprintf("%s(rk=%v)", k[:min(12, len(k))], hasRK))
	}
	acl.RUnlock()
	log.Printf("[CreateObjectTree] space=%s obj=%s curKeyID=%s acctKeyNil=%v keysCount=%d keys=%v",
		spaceID[:min(20, len(spaceID))], objectID, curKeyID, acctKey == nil, len(keysMap), keyInfo)

	// Encode tree root header as unencrypted metadata
	header, err := json.Marshal(TreeRootHeader{
		ObjectID:   objectID,
		ObjectType: objectType,
	})
	if err != nil {
		return nil, "", fmt.Errorf("marshaling header: %w", err)
	}

	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return nil, "", fmt.Errorf("generating seed: %w", err)
	}

	createPayload := objecttree.ObjectTreeCreatePayload{
		PrivKey:       signingKey,
		ChangeType:    changeType,
		ChangePayload: header,
		SpaceId:       spaceID,
		IsEncrypted:   true,
		Seed:          seed,
		Timestamp:     time.Now().Unix(),
	}

	treeBuilder := sp.TreeBuilder()
	storagePayload, err := treeBuilder.CreateTree(ctx, createPayload)
	if err != nil {
		return nil, "", fmt.Errorf("creating tree: %w", err)
	}

	tree, err := treeBuilder.PutTree(ctx, storagePayload, u.listener)
	if err != nil {
		return nil, "", fmt.Errorf("putting tree: %w", err)
	}

	treeID := tree.Id()

	// Register in all indexes
	u.trees.Store(treeID, tree)
	u.addToIndex(spaceID, treeID, ObjectIndexEntry{
		TreeID:     treeID,
		ObjectID:   objectID,
		ObjectType: objectType,
		ChangeType: changeType,
	})

	log.Printf("[UnifiedTreeManager] Created tree %s for object %s (type=%s) in space %s",
		treeID, objectID, objectType, spaceID)

	return tree, treeID, nil
}

// GetTreesForSpace returns all indexed trees in a space.
func (u *UnifiedTreeManager) GetTreesForSpace(spaceID string) []ObjectIndexEntry {
	idx, ok := u.spaceIndex.Load(spaceID)
	if !ok {
		return nil
	}

	var entries []ObjectIndexEntry
	idx.(*sync.Map).Range(func(key, value any) bool {
		entries = append(entries, value.(ObjectIndexEntry))
		return true
	})
	return entries
}

// GetTreesByType returns indexed trees of a specific object type in a space.
func (u *UnifiedTreeManager) GetTreesByType(spaceID, objectType string) []ObjectIndexEntry {
	all := u.GetTreesForSpace(spaceID)
	var filtered []ObjectIndexEntry
	for _, e := range all {
		if e.ObjectType == objectType {
			filtered = append(filtered, e)
		}
	}
	return filtered
}

// GetTreesByChangeType returns indexed trees with a specific root ChangeType.
func (u *UnifiedTreeManager) GetTreesByChangeType(spaceID, changeType string) []ObjectIndexEntry {
	all := u.GetTreesForSpace(spaceID)
	var filtered []ObjectIndexEntry
	for _, e := range all {
		if e.ChangeType == changeType {
			filtered = append(filtered, e)
		}
	}
	return filtered
}

// GetTreeForObject looks up a tree by object ID and returns it.
func (u *UnifiedTreeManager) GetTreeForObject(ctx context.Context, spaceID, objectID string) (objecttree.ObjectTree, error) {
	treeID, ok := u.objectMap.Load(objectID)
	if !ok {
		return nil, fmt.Errorf("no tree found for object %s", objectID)
	}
	return u.GetTree(ctx, spaceID, treeID.(string))
}

// GetTreeIDForObject returns the tree ID for a given object ID, or empty string.
func (u *UnifiedTreeManager) GetTreeIDForObject(objectID string) string {
	treeID, ok := u.objectMap.Load(objectID)
	if !ok {
		return ""
	}
	return treeID.(string)
}

// BuildSpaceIndex scans StoredIds(), reads root ChangeType + header, populates indexes.
// This is called after a space is opened to discover all existing trees.
func (u *UnifiedTreeManager) BuildSpaceIndex(ctx context.Context, spaceID string) error {
	if u.a == nil {
		return nil // test mode — trees are injected directly
	}
	sp, err := u.getSpace(ctx, spaceID)
	if err != nil {
		return fmt.Errorf("getting space %s: %w", spaceID, err)
	}

	storedIds := sp.StoredIds()
	builder := sp.TreeBuilder()
	indexed := 0

	// Get existing index for this space to skip already-indexed trees
	existingIdx, _ := u.spaceIndex.Load(spaceID)

	for _, treeID := range storedIds {
		// Skip if already indexed in the space index
		if existingIdx != nil {
			if _, ok := existingIdx.(*sync.Map).Load(treeID); ok {
				indexed++
				continue
			}
		}

		tree, err := builder.BuildTree(ctx, treeID, objecttreebuilder.BuildTreeOpts{
			Listener: u.listener,
		})
		if err != nil {
			continue
		}

		entry := u.extractIndexEntry(tree, treeID)
		if entry != nil {
			// Only add to index, don't cache the tree — it may not have all
			// content changes yet (they arrive via sync). GetTree will build
			// a fresh tree from storage on demand.
			u.addToIndex(spaceID, treeID, *entry)
			indexed++
		}
	}

	log.Printf("[UTM] BuildSpaceIndex space=%s storedIds=%d indexed=%d", spaceID, len(storedIds), indexed)
	log.Printf("[UnifiedTreeManager] BuildSpaceIndex space=%s storedIds=%d indexed=%d",
		spaceID, len(storedIds), indexed)
	return nil
}

// WaitForSync blocks until at least minTrees trees appear in the space index.
// Uses exponential backoff up to the given timeout.
func (u *UnifiedTreeManager) WaitForSync(ctx context.Context, spaceID string, minTrees int, timeout time.Duration) error {
	log.Printf("[UTM] WaitForSync start space=%s minTrees=%d timeout=%v appNil=%v", spaceID, minTrees, timeout, u.a == nil)
	deadline := time.Now().Add(timeout)
	backoff := 100 * time.Millisecond
	polls := 0

	for {
		polls++
		// Only call BuildSpaceIndex if the app is initialized (skip in tests)
		if u.a != nil {
			if err := u.BuildSpaceIndex(ctx, spaceID); err != nil {
				log.Printf("[UTM] WaitForSync BuildSpaceIndex error: %v", err)
				return err
			}
		}

		entries := u.GetTreesForSpace(spaceID)
		if len(entries) >= minTrees {
			log.Printf("[UTM] WaitForSync done space=%s found=%d polls=%d", spaceID, len(entries), polls)
			return nil
		}

		if time.Now().After(deadline) {
			log.Printf("[UTM] WaitForSync TIMEOUT space=%s got=%d want=%d polls=%d", spaceID, len(entries), minTrees, polls)
			return fmt.Errorf("timeout waiting for sync: got %d trees, want %d", len(entries), minTrees)
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
			if backoff < 2*time.Second {
				backoff *= 2
			}
		}
	}
}

// HasTrees returns true if any trees are indexed for the space.
func (u *UnifiedTreeManager) HasTrees(spaceID string) bool {
	entries := u.GetTreesForSpace(spaceID)
	return len(entries) > 0
}

// TreeCount returns the number of indexed trees for a space.
func (u *UnifiedTreeManager) TreeCount(spaceID string) int {
	return len(u.GetTreesForSpace(spaceID))
}

// RegisterSyncStatus stores a per-space sync status tracker for later retrieval.
func (u *UnifiedTreeManager) RegisterSyncStatus(spaceID string, status *matouSyncStatus) {
	u.syncStatus.Store(spaceID, status)
}

// GetSyncStatus returns the sync status tracker for a space, or nil if not registered.
func (u *UnifiedTreeManager) GetSyncStatus(spaceID string) *matouSyncStatus {
	val, ok := u.syncStatus.Load(spaceID)
	if !ok {
		return nil
	}
	return val.(*matouSyncStatus)
}

// --- Internal helpers ---

// addToIndex registers a tree in the space index and object map.
func (u *UnifiedTreeManager) addToIndex(spaceID, treeID string, entry ObjectIndexEntry) {
	idx, _ := u.spaceIndex.LoadOrStore(spaceID, &sync.Map{})
	idx.(*sync.Map).Store(treeID, entry)

	if entry.ObjectID != "" {
		u.objectMap.Store(entry.ObjectID, treeID)
	}
}

// removeFromIndex removes a tree from the space index and object map.
func (u *UnifiedTreeManager) removeFromIndex(spaceID, treeID string) {
	if idx, ok := u.spaceIndex.Load(spaceID); ok {
		if entry, ok := idx.(*sync.Map).LoadAndDelete(treeID); ok {
			e := entry.(ObjectIndexEntry)
			if e.ObjectID != "" {
				u.objectMap.Delete(e.ObjectID)
			}
		}
	}
}

// IndexTree extracts index information from a tree and adds it to the space index.
// Called by TreeSyncer workers after successfully fetching a missing tree.
func (u *UnifiedTreeManager) IndexTree(tree objecttree.ObjectTree, spaceID, treeID string) {
	if entry := u.extractIndexEntry(tree, treeID); entry != nil {
		u.addToIndex(spaceID, treeID, *entry)
		log.Printf("[UTM] IndexTree: indexed tree=%s objectId=%s objectType=%s in space=%s",
			treeID, entry.ObjectID, entry.ObjectType, spaceID[:min(20, len(spaceID))])
	}
}

// extractIndexEntry reads a tree's root change to determine its type and object ID.
// Uses tree.Header() raw bytes as the authoritative source (avoids in-memory Model issues).
func (u *UnifiedTreeManager) extractIndexEntry(tree objecttree.ObjectTree, treeID string) *ObjectIndexEntry {
	tree.Lock()
	defer tree.Unlock()

	// Primary path: parse raw header bytes directly as RootChange proto.
	// This is reliable regardless of in-memory tree state (reduction, Model clearing, etc.)
	if rawHeader := tree.Header(); rawHeader != nil && len(rawHeader.RawChange) > 0 {
		var rawTreeCh treechangeproto.RawTreeChange
		if err := rawTreeCh.UnmarshalVT(rawHeader.RawChange); err == nil {
			var rootCh treechangeproto.RootChange
			if err := rootCh.UnmarshalVT(rawTreeCh.Payload); err == nil {
				ct := rootCh.ChangeType
				if ct == ProfileTreeType || ct == CredentialTreeType || ct == ChatTreeType || ct == ObjectChangeType || ct == CredentialChangeType {
					e := &ObjectIndexEntry{
						TreeID:     treeID,
						ChangeType: ct,
					}
					if len(rootCh.ChangePayload) > 0 {
						var header TreeRootHeader
						if err := json.Unmarshal(rootCh.ChangePayload, &header); err == nil {
							e.ObjectID = header.ObjectID
							e.ObjectType = header.ObjectType
						}
					}
					log.Printf("[UTM] extractIndexEntry tree=%s OK changeType=%s objectId=%s objectType=%s",
						treeID, ct, e.ObjectID, e.ObjectType)
					return e
				}
			}
		}
	}

	// Fallback: iterate to find DataType from content changes (legacy trees)
	var entry *ObjectIndexEntry
	_ = tree.IterateRoot(
		func(change *objecttree.Change, decrypted []byte) (any, error) {
			return nil, nil
		},
		func(change *objecttree.Change) bool {
			if change.DataType == ObjectChangeType || change.DataType == CredentialChangeType {
				entry = &ObjectIndexEntry{
					TreeID:     treeID,
					ChangeType: change.DataType,
				}
				return false
			}
			return true
		},
	)
	if entry != nil {
		log.Printf("[UTM] extractIndexEntry tree=%s FALLBACK DataType=%s", treeID, entry.ChangeType)
	} else {
		log.Printf("[UTM] extractIndexEntry tree=%s NO MATCH", treeID)
	}
	return entry
}
