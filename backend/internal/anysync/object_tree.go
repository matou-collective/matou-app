// Package anysync provides any-sync integration for MATOU.
// object_tree.go manages generic typed object storage as CRDT objects in ObjectTrees.
// Objects are signed and synced via any-sync's P2P protocol alongside credentials.
package anysync

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/commonspace/object/tree/synctree/updatelistener"
	"github.com/anyproto/any-sync/commonspace/object/tree/treechangeproto"
	"github.com/anyproto/any-sync/commonspace/objecttreebuilder"
	"github.com/anyproto/any-sync/util/crypto"
)

// ObjectChangeType is the DataType used for generic object changes in ObjectTrees.
const ObjectChangeType = "matou.object.v1"

// ObjectPayload is the data stored in each ObjectTree change for a generic object.
type ObjectPayload struct {
	ID        string          `json:"id"`        // Unique object ID
	Type      string          `json:"type"`      // e.g. "SharedProfile", "type_definition"
	OwnerKey  string          `json:"ownerKey"`  // Public signing key of author
	Data      json.RawMessage `json:"data"`      // Arbitrary typed data
	Timestamp int64           `json:"timestamp"`
	Version   int             `json:"version"` // Monotonically increasing per ID
}

// ObjectTreeManager manages generic object storage in ObjectTrees.
// Each space shares the same tree as CredentialTreeManager but uses
// ObjectChangeType to distinguish object changes from credential changes.
type ObjectTreeManager struct {
	client     AnySyncClient
	keyManager *PeerKeyManager
	trees      *TreeCache
	listener   updatelistener.UpdateListener
}

// NewObjectTreeManager creates a new ObjectTreeManager using a shared TreeCache.
func NewObjectTreeManager(client AnySyncClient, keyManager *PeerKeyManager, cache *TreeCache) *ObjectTreeManager {
	return &ObjectTreeManager{
		client:     client,
		keyManager: keyManager,
		trees:      cache,
	}
}

// SetListener sets the UpdateListener for push-based change notification.
func (m *ObjectTreeManager) SetListener(l updatelistener.UpdateListener) {
	m.listener = l
}

// AddObject adds a generic object as a signed change to the space's tree.
// If no tree exists yet, one is created automatically.
func (m *ObjectTreeManager) AddObject(ctx context.Context, spaceID string, payload *ObjectPayload, signingKey crypto.PrivKey) (string, error) {
	tree, err := m.getOrCreateTree(ctx, spaceID, signingKey)
	if err != nil {
		return "", fmt.Errorf("getting tree for space %s: %w", spaceID, err)
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshaling object: %w", err)
	}

	// Register with listener before writing so the subsequent P2P callback
	// doesn't emit a spurious SSE event. Also persists to anystore immediately.
	if tul, ok := m.listener.(*TreeUpdateListener); ok && tul != nil {
		tul.RegisterObject(payload)
	}

	tree.Lock()
	defer tree.Unlock()

	result, err := tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        false,
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          ObjectChangeType,
	})
	if err != nil {
		return "", fmt.Errorf("adding content: %w", err)
	}

	if len(result.Heads) == 0 {
		return "", fmt.Errorf("no heads returned after adding content")
	}

	return result.Heads[0], nil
}

// ReadObjects reads all objects from a space's tree.
// Returns objects in tree traversal order, skipping credential changes.
func (m *ObjectTreeManager) ReadObjects(ctx context.Context, spaceID string) ([]*ObjectPayload, error) {
	tree, err := m.loadTree(ctx, spaceID)
	if err != nil {
		return nil, err
	}

	tree.Lock()
	defer tree.Unlock()

	var objects []*ObjectPayload

	err = tree.IterateRoot(
		func(change *objecttree.Change, decrypted []byte) (any, error) {
			if len(decrypted) == 0 {
				return nil, nil
			}
			// Only process object changes
			if change.DataType != ObjectChangeType {
				return nil, nil
			}
			var p ObjectPayload
			if err := json.Unmarshal(decrypted, &p); err != nil {
				return nil, fmt.Errorf("unmarshaling object: %w", err)
			}
			return &p, nil
		},
		func(change *objecttree.Change) bool {
			if change.Model == nil {
				return true
			}
			if o, ok := change.Model.(*ObjectPayload); ok {
				objects = append(objects, o)
			}
			return true
		},
	)
	if err != nil {
		return nil, fmt.Errorf("iterating tree: %w", err)
	}

	return objects, nil
}

// ReadObjectsByType reads all objects of a specific type from a space's tree.
func (m *ObjectTreeManager) ReadObjectsByType(ctx context.Context, spaceID string, typeName string) ([]*ObjectPayload, error) {
	all, err := m.ReadObjects(ctx, spaceID)
	if err != nil {
		return nil, err
	}

	var filtered []*ObjectPayload
	for _, obj := range all {
		if obj.Type == typeName {
			filtered = append(filtered, obj)
		}
	}
	return filtered, nil
}

// ReadLatestByID reads the latest version of a specific object by ID.
func (m *ObjectTreeManager) ReadLatestByID(ctx context.Context, spaceID string, objectID string) (*ObjectPayload, error) {
	all, err := m.ReadObjects(ctx, spaceID)
	if err != nil {
		return nil, err
	}

	var latest *ObjectPayload
	for _, obj := range all {
		if obj.ID == objectID {
			if latest == nil || obj.Version > latest.Version {
				latest = obj
			}
		}
	}

	if latest == nil {
		return nil, fmt.Errorf("object %s not found in space %s", objectID, spaceID)
	}
	return latest, nil
}

// HasObjectTree returns true if an ObjectTree exists for the given space,
// either in cache or discoverable from the space storage.
func (m *ObjectTreeManager) HasObjectTree(ctx context.Context, spaceID string) bool {
	if _, ok := m.trees.Load(spaceID); ok {
		return true
	}
	err := m.discoverTree(ctx, spaceID)
	return err == nil
}

// loadTree loads an existing tree from the cache or discovers it from the space.
func (m *ObjectTreeManager) loadTree(ctx context.Context, spaceID string) (objecttree.ObjectTree, error) {
	if tree, ok := m.trees.Load(spaceID); ok {
		return tree, nil
	}

	// Try to discover the tree
	if err := m.discoverTree(ctx, spaceID); err != nil {
		return nil, fmt.Errorf("no tree for space %s: %w", spaceID, err)
	}

	tree, ok := m.trees.Load(spaceID)
	if !ok {
		return nil, fmt.Errorf("no tree for space %s", spaceID)
	}
	return tree, nil
}

// discoverTree discovers and loads a tree from the space storage that contains objects.
func (m *ObjectTreeManager) discoverTree(ctx context.Context, spaceID string) error {
	if m.client == nil {
		return fmt.Errorf("no client configured")
	}
	space, err := m.client.GetSpace(ctx, spaceID)
	if err != nil {
		return fmt.Errorf("getting space: %w", err)
	}

	storedIds := space.StoredIds()
	builder := space.TreeBuilder()

	for _, treeID := range storedIds {
		tree, err := builder.BuildTree(ctx, treeID, objecttreebuilder.BuildTreeOpts{
			Listener: m.listener,
		})
		if err != nil {
			continue
		}

		tree.Lock()
		isObjectTree := false
		_ = tree.IterateRoot(
			func(change *objecttree.Change, decrypted []byte) (any, error) {
				return nil, nil
			},
			func(change *objecttree.Change) bool {
				if change.DataType == ObjectChangeType {
					isObjectTree = true
					return false
				}
				if info, ok := change.Model.(*treechangeproto.TreeChangeInfo); ok {
					if info.ChangeType == ObjectChangeType {
						isObjectTree = true
						return false
					}
				}
				return true
			},
		)
		tree.Unlock()
		if isObjectTree {
			m.trees.Store(spaceID, tree)
			return nil
		}
	}
	return fmt.Errorf("no object tree found in %d stored objects", len(storedIds))
}

// getOrCreateTree returns the existing tree for a space, or creates one.
func (m *ObjectTreeManager) getOrCreateTree(ctx context.Context, spaceID string, signingKey crypto.PrivKey) (objecttree.ObjectTree, error) {
	if tree, ok := m.trees.Load(spaceID); ok {
		return tree, nil
	}

	// Try discovery first (tree may have been created by credential manager or peer)
	if err := m.discoverTree(ctx, spaceID); err == nil {
		if tree, ok := m.trees.Load(spaceID); ok {
			return tree, nil
		}
	}

	// Create new tree
	_, err := m.createTree(ctx, spaceID, signingKey)
	if err != nil {
		return nil, err
	}

	tree, ok := m.trees.Load(spaceID)
	if !ok {
		return nil, fmt.Errorf("tree not found after creation for space %s", spaceID)
	}
	return tree, nil
}

// createTree creates a new ObjectTree in a space.
func (m *ObjectTreeManager) createTree(ctx context.Context, spaceID string, signingKey crypto.PrivKey) (string, error) {
	space, err := m.client.GetSpace(ctx, spaceID)
	if err != nil {
		return "", fmt.Errorf("getting space %s: %w", spaceID, err)
	}

	treeBuilder := space.TreeBuilder()

	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return "", fmt.Errorf("generating seed: %w", err)
	}

	payload := objecttree.ObjectTreeCreatePayload{
		PrivKey:       signingKey,
		ChangeType:    ObjectChangeType,
		ChangePayload: nil,
		SpaceId:       spaceID,
		IsEncrypted:   true,
		Seed:          seed,
		Timestamp:     time.Now().Unix(),
	}

	storagePayload, err := treeBuilder.CreateTree(ctx, payload)
	if err != nil {
		return "", fmt.Errorf("creating tree: %w", err)
	}

	tree, err := treeBuilder.PutTree(ctx, storagePayload, m.listener)
	if err != nil {
		return "", fmt.Errorf("putting tree: %w", err)
	}

	m.trees.Store(spaceID, tree)
	return tree.Id(), nil
}
