// Package anysync provides any-sync integration for MATOU.
// contrib_adapter.go bridges ObjectTreeManager to the contributions.ObjectStore interface
// using Go duck typing (implicit interface satisfaction).
package anysync

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/matou-dao/backend/internal/contributions"
	"github.com/matou-dao/backend/internal/identity"
)

// ObjectStoreAdapter bridges ObjectTreeManager to the contributions.ObjectStore interface.
// It provides Save/Get/List/Delete operations backed by any-sync encrypted object trees.
//
// The adapter satisfies the contributions.ObjectStore interface implicitly (duck typing).
// It imports the contributions package only for concrete types used in RegisterInterest
// and AttachFile — there is no circular dependency because contributions does not import
// anysync.
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

// RegisterInterest appends a new InterestedContributor to the
// "interested_contributors" JSON array field on the contribution tree.
// It follows a read-modify-write pattern: read the current array, append,
// then write back via Save.
func (a *ObjectStoreAdapter) RegisterInterest(ctx context.Context, treeID string, contributor contributions.InterestedContributor) error {
	var current []contributions.InterestedContributor
	if err := extractJSONField(ctx, a, treeID, treeID, "interested_contributors", &current); err != nil {
		// Field not present yet — start with empty slice.
		current = []contributions.InterestedContributor{}
	}

	current = append(current, contributor)

	updated, err := json.Marshal(current)
	if err != nil {
		return fmt.Errorf("marshaling interested_contributors: %w", err)
	}

	return updateJSONField(ctx, a, treeID, treeID, TypeContribution, "interested_contributors", updated)
}

// AttachFile appends a new FileRef to the specified JSON array field
// (one of "evidence_files", "attachment_files") on the contribution tree.
// It follows the same read-modify-write pattern as RegisterInterest.
func (a *ObjectStoreAdapter) AttachFile(ctx context.Context, treeID string, fileRef contributions.FileRef, fieldName string) error {
	var current []contributions.FileRef
	if err := extractJSONField(ctx, a, treeID, treeID, fieldName, &current); err != nil {
		// Field not present yet — start with empty slice.
		current = []contributions.FileRef{}
	}

	current = append(current, fileRef)

	updated, err := json.Marshal(current)
	if err != nil {
		return fmt.Errorf("marshaling %s: %w", fieldName, err)
	}

	return updateJSONField(ctx, a, treeID, treeID, TypeContribution, fieldName, updated)
}

// extractJSONField reads the current state of an object tree and unmarshals
// the named field into dest. Returns an error if the object is not found,
// the field is absent, or the JSON cannot be decoded.
func extractJSONField(ctx context.Context, a *ObjectStoreAdapter, spaceID, objectID, fieldName string, dest interface{}) error {
	obj, err := a.trees.ReadObjectByID(ctx, spaceID, objectID)
	if err != nil {
		return fmt.Errorf("reading object %s: %w", objectID, err)
	}

	// obj.Data is a flat JSON object — unmarshal into a generic map first.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(obj.Data, &raw); err != nil {
		return fmt.Errorf("parsing object data for %s: %w", objectID, err)
	}

	fieldData, ok := raw[fieldName]
	if !ok {
		return fmt.Errorf("field %q not present on object %s", fieldName, objectID)
	}

	if err := json.Unmarshal(fieldData, dest); err != nil {
		return fmt.Errorf("decoding field %q on object %s: %w", fieldName, objectID, err)
	}

	return nil
}

// updateJSONField reads the current object state, replaces (or adds) fieldName
// with the provided JSON value, then calls Save to write it back as an
// incremental diff change on the tree.
func updateJSONField(ctx context.Context, a *ObjectStoreAdapter, spaceID, objectID, objectType, fieldName string, value json.RawMessage) error {
	// Read existing state so we can pass the full merged payload to Save.
	obj, err := a.trees.ReadObjectByID(ctx, spaceID, objectID)
	if err != nil {
		return fmt.Errorf("reading object %s for field update: %w", objectID, err)
	}

	// Decode current data into a mutable map.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(obj.Data, &raw); err != nil {
		return fmt.Errorf("parsing object data for %s: %w", objectID, err)
	}

	raw[fieldName] = value

	merged, err := json.Marshal(raw)
	if err != nil {
		return fmt.Errorf("re-marshaling updated object %s: %w", objectID, err)
	}

	return a.Save(spaceID, objectID, objectType, json.RawMessage(merged))
}
