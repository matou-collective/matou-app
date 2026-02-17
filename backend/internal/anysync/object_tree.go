// Package anysync provides any-sync integration for MATOU.
// object_tree.go manages generic typed object storage using a tree-per-object model.
// Each object (profile, type definition) gets its own ObjectTree, managed by the
// UnifiedTreeManager. Changes are stored as incremental field operations (ChangeOp)
// and state is reconstructed by replaying these operations (BuildState).
package anysync

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/util/crypto"
)

// ObjectChangeType is the DataType used for generic object changes in ObjectTrees.
const ObjectChangeType = "matou.object.v1"

// ObjectPayload is the API-level representation of an object.
// It provides backward compatibility with existing API responses.
// Internally, data is stored as incremental ChangeOps in the tree.
type ObjectPayload struct {
	ID        string          `json:"id"`        // Unique object ID
	Type      string          `json:"type"`      // e.g. "SharedProfile", "type_definition"
	OwnerKey  string          `json:"ownerKey"`  // Public signing key of author
	Data      json.RawMessage `json:"data"`      // Flat JSON object (reconstructed from state)
	Timestamp int64           `json:"timestamp"`
	Version   int             `json:"version"` // Number of changes applied
	TreeID    string          `json:"treeId,omitempty"` // any-sync tree ID
}

// ObjectTreeManager manages generic object storage using tree-per-object model.
// Each object gets its own ObjectTree via UnifiedTreeManager.
type ObjectTreeManager struct {
	client      AnySyncClient
	keyManager  *PeerKeyManager
	treeManager *UnifiedTreeManager
}

// NewObjectTreeManager creates a new ObjectTreeManager backed by UnifiedTreeManager.
func NewObjectTreeManager(client AnySyncClient, keyManager *PeerKeyManager, treeManager *UnifiedTreeManager) *ObjectTreeManager {
	return &ObjectTreeManager{
		client:      client,
		keyManager:  keyManager,
		treeManager: treeManager,
	}
}

// CreateObject creates a new object with its own tree and initial field values.
// Returns the tree ID and head ID.
func (m *ObjectTreeManager) CreateObject(
	ctx context.Context, spaceID, objectID, objectType, changeType string,
	fields map[string]json.RawMessage, signingKey crypto.PrivKey,
) (treeID string, headID string, err error) {
	// Create a new tree for this object
	tree, treeID, err := m.treeManager.CreateObjectTree(ctx, spaceID, objectID, objectType, changeType, signingKey)
	if err != nil {
		return "", "", fmt.Errorf("creating object tree: %w", err)
	}

	// Build the initial change with all fields as "set" ops
	initOps := InitChange(fields)
	data, err := json.Marshal(initOps)
	if err != nil {
		return "", "", fmt.Errorf("marshaling init change: %w", err)
	}

	tree.Lock()
	defer tree.Unlock()

	result, err := tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        true, // first change is a snapshot
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          ObjectChangeType,
	})
	if err != nil {
		return "", "", fmt.Errorf("adding init content: %w", err)
	}

	if len(result.Heads) == 0 {
		return "", "", fmt.Errorf("no heads returned after adding content")
	}

	log.Printf("[ObjectTree] CreateObject id=%s type=%s treeId=%s space=%s",
		objectID, objectType, treeID, spaceID)

	return treeID, result.Heads[0], nil
}

// UpdateObject updates an existing object with incremental field changes.
// Only changed fields are stored. Returns empty headID if no changes detected.
func (m *ObjectTreeManager) UpdateObject(
	ctx context.Context, spaceID, objectID string,
	newFields map[string]json.RawMessage, signingKey crypto.PrivKey,
) (headID string, err error) {
	tree, err := m.treeManager.GetTreeForObject(ctx, spaceID, objectID)
	if err != nil {
		return "", fmt.Errorf("getting tree for object %s: %w", objectID, err)
	}

	// Read current state (with lock)
	tree.Lock()
	state, err := BuildState(tree, objectID, "")
	if err != nil {
		tree.Unlock()
		return "", fmt.Errorf("building state for %s: %w", objectID, err)
	}

	// Compute diff
	diff := DiffState(state, newFields)
	if diff == nil {
		tree.Unlock()
		return "", nil // no changes
	}

	data, err := json.Marshal(diff)
	if err != nil {
		tree.Unlock()
		return "", fmt.Errorf("marshaling diff: %w", err)
	}

	// Check if we need a snapshot
	isSnapshot := NeedsSnapshot(state)
	if isSnapshot {
		// Apply the diff to current state first, then create snapshot
		for _, op := range diff.Ops {
			switch op.Op {
			case "set":
				state.Fields[op.Field] = op.Value
			case "unset":
				delete(state.Fields, op.Field)
			}
		}
		snap := SnapshotChange(state)
		data, err = json.Marshal(snap)
		if err != nil {
			tree.Unlock()
			return "", fmt.Errorf("marshaling snapshot: %w", err)
		}
	}

	result, err := tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        isSnapshot,
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          ObjectChangeType,
	})
	tree.Unlock()

	if err != nil {
		return "", fmt.Errorf("adding content: %w", err)
	}

	if len(result.Heads) == 0 {
		return "", fmt.Errorf("no heads returned after adding content")
	}

	return result.Heads[0], nil
}

// AddObject adds an object using the legacy ObjectPayload format.
// For new objects, it creates a tree. For existing objects, it updates.
// This provides backward compatibility with existing API handlers.
func (m *ObjectTreeManager) AddObject(ctx context.Context, spaceID string, payload *ObjectPayload, signingKey crypto.PrivKey) (string, error) {
	fields, err := FieldsFromJSON(payload.Data)
	if err != nil {
		return "", fmt.Errorf("parsing object data: %w", err)
	}

	// Check if object already has a tree
	existingTree, _ := m.treeManager.GetTreeForObject(ctx, spaceID, payload.ID)
	if existingTree != nil {
		// Update existing object
		headID, err := m.UpdateObject(ctx, spaceID, payload.ID, fields, signingKey)
		if err != nil {
			return "", err
		}
		if headID == "" {
			// No changes detected, return current head
			return "", nil
		}
		return headID, nil
	}

	// Determine the tree type based on object type
	changeType := ProfileTreeType
	switch payload.Type {
	case "ChatChannel", "ChatMessage", "MessageReaction":
		changeType = ChatTreeType
	}

	// Create new object
	_, headID, err := m.CreateObject(ctx, spaceID, payload.ID, payload.Type, changeType, fields, signingKey)
	return headID, err
}

// ReadObject reads a single object by ID, returning its reconstructed state as ObjectPayload.
func (m *ObjectTreeManager) ReadObject(ctx context.Context, spaceID, objectID string) (*ObjectPayload, error) {
	tree, err := m.treeManager.GetTreeForObject(ctx, spaceID, objectID)
	if err != nil {
		return nil, fmt.Errorf("object %s not found: %w", objectID, err)
	}

	// Get index entry for type info
	entry := m.getIndexEntry(objectID)

	tree.Lock()
	state, err := BuildState(tree, objectID, entry.ObjectType)
	tree.Unlock()
	if err != nil {
		return nil, fmt.Errorf("building state for %s: %w", objectID, err)
	}

	return stateToPayload(state, tree.Id()), nil
}

// ReadObjectsByType reads all objects of a specific type from a space.
func (m *ObjectTreeManager) ReadObjectsByType(ctx context.Context, spaceID, typeName string) ([]*ObjectPayload, error) {
	entries := m.treeManager.GetTreesByType(spaceID, typeName)
	log.Printf("[ObjectTree] ReadObjectsByType space=%s type=%s entries=%d", spaceID, typeName, len(entries))
	if len(entries) == 0 {
		return nil, nil
	}

	var objects []*ObjectPayload
	for _, entry := range entries {
		tree, err := m.treeManager.GetTree(ctx, spaceID, entry.TreeID)
		if err != nil {
			log.Printf("[ObjectTree] Warning: failed to get tree %s for object %s: %v",
				entry.TreeID, entry.ObjectID, err)
			continue
		}

		tree.Lock()
		state, err := BuildState(tree, entry.ObjectID, entry.ObjectType)
		tree.Unlock()
		if err != nil {
			log.Printf("[ObjectTree] Warning: failed to build state for %s: %v",
				entry.ObjectID, err)
			continue
		}

		objects = append(objects, stateToPayload(state, entry.TreeID))
	}

	log.Printf("[ObjectTree] ReadObjectsByType space=%s type=%s result=%d", spaceID, typeName, len(objects))
	return objects, nil
}

// ReadObjects reads all profile objects from a space (all types).
// This is used by sync-status and other callers that need all objects.
func (m *ObjectTreeManager) ReadObjects(ctx context.Context, spaceID string) ([]*ObjectPayload, error) {
	entries := m.treeManager.GetTreesByChangeType(spaceID, ProfileTreeType)
	entries = append(entries, m.treeManager.GetTreesByChangeType(spaceID, ChatTreeType)...)
	if len(entries) == 0 {
		// Also check for legacy ObjectChangeType trees
		entries = m.treeManager.GetTreesByChangeType(spaceID, ObjectChangeType)
	}

	var objects []*ObjectPayload
	for _, entry := range entries {
		tree, err := m.treeManager.GetTree(ctx, spaceID, entry.TreeID)
		if err != nil {
			continue
		}

		tree.Lock()
		state, err := BuildState(tree, entry.ObjectID, entry.ObjectType)
		tree.Unlock()
		if err != nil {
			continue
		}

		objects = append(objects, stateToPayload(state, entry.TreeID))
	}

	return objects, nil
}

// ReadLatestByID reads the latest version of a specific object by ID.
// Backward-compatible with the old API.
func (m *ObjectTreeManager) ReadLatestByID(ctx context.Context, spaceID, objectID string) (*ObjectPayload, error) {
	return m.ReadObject(ctx, spaceID, objectID)
}

// GetTreeIDForObject returns the tree ID for a given object ID.
func (m *ObjectTreeManager) GetTreeIDForObject(objectID string) string {
	return m.treeManager.GetTreeIDForObject(objectID)
}

// HasObjectTree returns true if any profile trees exist for the given space.
func (m *ObjectTreeManager) HasObjectTree(ctx context.Context, spaceID string) bool {
	entries := m.treeManager.GetTreesByChangeType(spaceID, ProfileTreeType)
	if len(entries) > 0 {
		return true
	}
	entries = m.treeManager.GetTreesByChangeType(spaceID, ChatTreeType)
	if len(entries) > 0 {
		return true
	}
	// Also check legacy
	entries = m.treeManager.GetTreesByChangeType(spaceID, ObjectChangeType)
	return len(entries) > 0
}

// --- Internal helpers ---

func (m *ObjectTreeManager) getIndexEntry(objectID string) ObjectIndexEntry {
	treeID := m.treeManager.GetTreeIDForObject(objectID)
	if treeID == "" {
		return ObjectIndexEntry{}
	}
	// Search space index for this tree
	var found ObjectIndexEntry
	m.treeManager.spaceIndex.Range(func(_, idx any) bool {
		idx.(*sync.Map).Range(func(key, value any) bool {
			entry := value.(ObjectIndexEntry)
			if entry.TreeID == treeID {
				found = entry
				return false
			}
			return true
		})
		return found.TreeID == ""
	})
	return found
}

// stateToPayload converts an ObjectState to an ObjectPayload for API responses.
func stateToPayload(state *ObjectState, treeID string) *ObjectPayload {
	return &ObjectPayload{
		ID:        state.ObjectID,
		Type:      state.ObjectType,
		OwnerKey:  state.OwnerKey,
		Data:      state.ToJSON(),
		Timestamp: state.Timestamp,
		Version:   state.Version,
		TreeID:    treeID,
	}
}
