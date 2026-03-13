// Package anysync provides any-sync integration for MATOU.
// contrib_adapter.go bridges ObjectTreeManager to the contributions.ObjectStore interface
// using Go duck typing (implicit interface satisfaction).
package anysync

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/matou-dao/backend/internal/identity"
)

// ObjectStoreAdapter bridges ObjectTreeManager to the contributions.ObjectStore interface.
// It provides Save/Get/List/Delete operations backed by any-sync encrypted object trees.
//
// The adapter satisfies the contributions.ObjectStore interface implicitly (duck typing).
// It does NOT import the contributions package to avoid circular dependencies.
//
// Signing keys come from AnySyncClient.GetSigningKey(); the peer ID used as the owner
// key comes from identity.UserIdentity.GetPeerID().
type ObjectStoreAdapter struct {
	trees    *ObjectTreeManager
	client   AnySyncClient          // for GetSigningKey()
	identity *identity.UserIdentity // for GetPeerID()
}

// NewObjectStoreAdapter creates an ObjectStoreAdapter backed by the given tree manager.
func NewObjectStoreAdapter(trees *ObjectTreeManager, client AnySyncClient, id *identity.UserIdentity) *ObjectStoreAdapter {
	return &ObjectStoreAdapter{
		trees:    trees,
		client:   client,
		identity: id,
	}
}

// Save marshals data to JSON and stores it as an object in the space's tree.
// If an object with objectID already exists it is updated (incremental diff);
// otherwise a new tree is created.
func (a *ObjectStoreAdapter) Save(spaceID, objectID, objectType string, data interface{}) error {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshaling data: %w", err)
	}

	signingKey := a.client.GetSigningKey()
	if signingKey == nil {
		return fmt.Errorf("no signing key available")
	}

	payload := &ObjectPayload{
		ID:       objectID,
		Type:     objectType,
		OwnerKey: a.identity.GetPeerID(),
		Data:     jsonData,
	}

	_, err = a.trees.AddObject(context.Background(), spaceID, payload, signingKey)
	return err
}

// Get reads a single object by ID and unmarshals its Data field into dest.
func (a *ObjectStoreAdapter) Get(spaceID, objectID string, dest interface{}) error {
	obj, err := a.trees.ReadObjectByID(context.Background(), spaceID, objectID)
	if err != nil {
		return err
	}
	return json.Unmarshal(obj.Data, dest)
}

// List returns all objects of a given type in the space as raw JSON payloads.
// Each element is the Data field of the stored ObjectPayload.
func (a *ObjectStoreAdapter) List(spaceID, objectType string) ([]json.RawMessage, error) {
	objects, err := a.trees.ReadObjectsByType(context.Background(), spaceID, objectType)
	if err != nil {
		return nil, err
	}

	results := make([]json.RawMessage, 0, len(objects))
	for _, obj := range objects {
		results = append(results, obj.Data)
	}
	return results, nil
}

// Delete marks an object as deleted by appending a tombstone record.
// any-sync trees are append-only, so deletion is represented as an update
// that sets a "deleted" tombstone field on the object.
func (a *ObjectStoreAdapter) Delete(spaceID, objectID string) error {
	return a.Save(spaceID, objectID, "tombstone", map[string]string{"deleted": objectID})
}
