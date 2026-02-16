// Package anysync provides any-sync integration for MATOU.
// credential_tree.go manages credential storage using a tree-per-credential model.
// Each credential gets its own ObjectTree, managed by the UnifiedTreeManager.
// Credentials are immutable — a single init change per tree, no updates needed.
package anysync

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/util/crypto"
)

// CredentialChangeType is the DataType/ChangeType used for credential trees.
const CredentialChangeType = "matou.credential.v1"

// CredentialPayload is the data stored in each credential tree.
type CredentialPayload struct {
	SAID      string          `json:"said"`
	Issuer    string          `json:"issuer"`
	Recipient string          `json:"recipient"`
	Schema    string          `json:"schema"`
	Data      json.RawMessage `json:"data"`
	Timestamp int64           `json:"timestamp"`
	TreeID    string          `json:"treeId,omitempty"`
}

// CredentialTreeManager manages credential storage using tree-per-credential model.
// Each credential gets its own ObjectTree via UnifiedTreeManager.
type CredentialTreeManager struct {
	client      AnySyncClient
	keyManager  *PeerKeyManager
	treeManager *UnifiedTreeManager
}

// NewCredentialTreeManager creates a new CredentialTreeManager backed by UnifiedTreeManager.
func NewCredentialTreeManager(client AnySyncClient, keyManager *PeerKeyManager, treeManager *UnifiedTreeManager) *CredentialTreeManager {
	return &CredentialTreeManager{
		client:      client,
		keyManager:  keyManager,
		treeManager: treeManager,
	}
}

// AddCredential creates a new tree for a credential and stores it as a single change.
// Credentials are immutable — one init change per tree, no updates.
func (m *CredentialTreeManager) AddCredential(ctx context.Context, spaceID string, cred *CredentialPayload, signingKey crypto.PrivKey) (string, error) {
	// Use SAID as the object ID for the tree
	objectID := fmt.Sprintf("Credential-%s", cred.SAID)
	objectType := "Credential"
	if cred.Schema != "" {
		objectType = cred.Schema
	}

	// Create a new tree for this credential
	tree, treeID, err := m.treeManager.CreateObjectTree(ctx, spaceID, objectID, objectType, CredentialTreeType, signingKey)
	if err != nil {
		return "", fmt.Errorf("creating credential tree: %w", err)
	}

	// Build fields from credential payload
	fields := make(map[string]json.RawMessage)
	if b, err := json.Marshal(cred.SAID); err == nil {
		fields["said"] = b
	}
	if b, err := json.Marshal(cred.Issuer); err == nil {
		fields["issuer"] = b
	}
	if b, err := json.Marshal(cred.Recipient); err == nil {
		fields["recipient"] = b
	}
	if b, err := json.Marshal(cred.Schema); err == nil {
		fields["schema"] = b
	}
	if len(cred.Data) > 0 {
		fields["data"] = cred.Data
	}

	// Create init change with all fields
	initOps := InitChange(fields)
	data, err := json.Marshal(initOps)
	if err != nil {
		return "", fmt.Errorf("marshaling credential change: %w", err)
	}

	tree.Lock()
	defer tree.Unlock()

	result, err := tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        true, // single change is a snapshot
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          CredentialChangeType,
	})
	if err != nil {
		return "", fmt.Errorf("adding credential content: %w", err)
	}

	if len(result.Heads) == 0 {
		return "", fmt.Errorf("no heads returned after adding credential")
	}

	fmt.Printf("[CredentialTree] Added credential %s (schema=%s) treeId=%s space=%s\n",
		cred.SAID, cred.Schema, treeID, spaceID)

	return result.Heads[0], nil
}

// ReadCredentials reads all credentials from a space by finding all credential trees.
func (m *CredentialTreeManager) ReadCredentials(ctx context.Context, spaceID string) ([]*CredentialPayload, error) {
	entries := m.treeManager.GetTreesByChangeType(spaceID, CredentialTreeType)
	if len(entries) == 0 {
		// Also check legacy CredentialChangeType trees
		entries = m.treeManager.GetTreesByChangeType(spaceID, CredentialChangeType)
	}

	var creds []*CredentialPayload
	for _, entry := range entries {
		tree, err := m.treeManager.GetTree(ctx, spaceID, entry.TreeID)
		if err != nil {
			continue
		}

		cred, err := m.readCredFromTree(tree, entry)
		if err != nil {
			fmt.Printf("[CredentialTree] Warning: failed to read credential from tree %s: %v\n",
				entry.TreeID, err)
			continue
		}

		creds = append(creds, cred)
	}

	return creds, nil
}

// ReadCredential reads a single credential by its SAID.
func (m *CredentialTreeManager) ReadCredential(ctx context.Context, spaceID, said string) (*CredentialPayload, error) {
	objectID := fmt.Sprintf("Credential-%s", said)
	tree, err := m.treeManager.GetTreeForObject(ctx, spaceID, objectID)
	if err != nil {
		return nil, fmt.Errorf("credential %s not found: %w", said, err)
	}

	entry := ObjectIndexEntry{
		TreeID:   tree.Id(),
		ObjectID: objectID,
	}

	return m.readCredFromTree(tree, entry)
}

// GetTreeID returns the tree ID for a credential by its SAID.
func (m *CredentialTreeManager) GetTreeID(said string) string {
	objectID := fmt.Sprintf("Credential-%s", said)
	return m.treeManager.GetTreeIDForObject(objectID)
}

// --- Internal helpers ---

// readCredFromTree reads a credential from its tree by building state and converting.
func (m *CredentialTreeManager) readCredFromTree(tree objecttree.ObjectTree, entry ObjectIndexEntry) (*CredentialPayload, error) {
	tree.Lock()
	state, err := BuildState(tree, entry.ObjectID, entry.ObjectType)
	tree.Unlock()
	if err != nil {
		return nil, err
	}

	return stateToCredential(state, tree.Id())
}

// stateToCredential converts an ObjectState back to a CredentialPayload.
func stateToCredential(state *ObjectState, treeID string) (*CredentialPayload, error) {
	cred := &CredentialPayload{
		Timestamp: state.Timestamp,
		TreeID:    treeID,
	}

	if v, ok := state.Fields["said"]; ok {
		json.Unmarshal(v, &cred.SAID)
	}
	if v, ok := state.Fields["issuer"]; ok {
		json.Unmarshal(v, &cred.Issuer)
	}
	if v, ok := state.Fields["recipient"]; ok {
		json.Unmarshal(v, &cred.Recipient)
	}
	if v, ok := state.Fields["schema"]; ok {
		json.Unmarshal(v, &cred.Schema)
	}
	if v, ok := state.Fields["data"]; ok {
		cred.Data = v
	}

	return cred, nil
}
