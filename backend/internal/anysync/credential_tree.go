// Package anysync provides any-sync integration for MATOU.
// credential_tree.go manages credential storage as CRDT objects in ObjectTrees.
// Credentials are signed and synced via any-sync's P2P protocol.
package anysync

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/commonspace/object/tree/treechangeproto"
	"github.com/anyproto/any-sync/commonspace/objecttreebuilder"
	"github.com/anyproto/any-sync/util/crypto"
)

// CredentialChangeType is the DataType used for credential changes in ObjectTrees.
const CredentialChangeType = "matou.credential.v1"

// CredentialPayload is the data stored in each ObjectTree change for a credential.
type CredentialPayload struct {
	SAID      string          `json:"said"`
	Issuer    string          `json:"issuer"`
	Recipient string          `json:"recipient"`
	Schema    string          `json:"schema"`
	Data      json.RawMessage `json:"data"`
	Timestamp int64           `json:"timestamp"`
}

// CredentialTreeManager manages credential storage in ObjectTrees.
// Each space has one credential tree for storing KERI credentials as
// encrypted, signed CRDT changes. Peers must join the space via ACL
// invite to receive the ReadKey needed to decrypt credential data.
type CredentialTreeManager struct {
	client     AnySyncClient
	keyManager *PeerKeyManager
	trees      sync.Map // spaceID → objecttree.ObjectTree
}

// NewCredentialTreeManager creates a new CredentialTreeManager.
func NewCredentialTreeManager(client AnySyncClient, keyManager *PeerKeyManager) *CredentialTreeManager {
	return &CredentialTreeManager{
		client:     client,
		keyManager: keyManager,
	}
}

// CreateCredentialTree creates a new ObjectTree in a space for storing credentials.
// The tree is encrypted — peers must join the space via ACL invite to receive the
// ReadKey needed to decrypt credential data. Integrity is ensured by Ed25519 signatures.
func (m *CredentialTreeManager) CreateCredentialTree(ctx context.Context, spaceID string, signingKey crypto.PrivKey) (string, error) {
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
		ChangeType:    CredentialChangeType,
		ChangePayload: nil, // empty initial payload
		SpaceId:       spaceID,
		IsEncrypted:   true,
		Seed:          seed,
		Timestamp:     time.Now().Unix(),
	}

	storagePayload, err := treeBuilder.CreateTree(ctx, payload)
	if err != nil {
		return "", fmt.Errorf("creating tree: %w", err)
	}

	tree, err := treeBuilder.PutTree(ctx, storagePayload, nil)
	if err != nil {
		return "", fmt.Errorf("putting tree: %w", err)
	}

	m.trees.Store(spaceID, tree)
	return tree.Id(), nil
}

// AddCredential adds a credential as a signed change to the space's credential
// tree. If no tree exists yet, one is created automatically.
func (m *CredentialTreeManager) AddCredential(ctx context.Context, spaceID string, cred *CredentialPayload, signingKey crypto.PrivKey) (string, error) {
	tree, err := m.getOrCreateTree(ctx, spaceID, signingKey)
	if err != nil {
		return "", fmt.Errorf("getting tree for space %s: %w", spaceID, err)
	}

	data, err := json.Marshal(cred)
	if err != nil {
		return "", fmt.Errorf("marshaling credential: %w", err)
	}

	tree.Lock()
	defer tree.Unlock()

	result, err := tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        false,
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          CredentialChangeType,
	})
	if err != nil {
		return "", fmt.Errorf("adding content: %w", err)
	}

	if len(result.Heads) == 0 {
		return "", fmt.Errorf("no heads returned after adding content")
	}

	return result.Heads[0], nil
}

// ReadCredentials reads all credentials from a space's credential tree.
// Returns credentials in tree traversal order. If no tree is cached, it
// discovers credential trees from the space storage (supports reading trees
// created by other peers and synced via tree nodes).
func (m *CredentialTreeManager) ReadCredentials(ctx context.Context, spaceID string) ([]*CredentialPayload, error) {
	val, ok := m.trees.Load(spaceID)
	if !ok {
		// Try to discover and load a credential tree from the space storage
		if err := m.discoverTree(ctx, spaceID); err != nil {
			return nil, fmt.Errorf("no credential tree for space %s: %w", spaceID, err)
		}
		val, ok = m.trees.Load(spaceID)
		if !ok {
			return nil, fmt.Errorf("no credential tree for space %s", spaceID)
		}
	}

	tree := val.(objecttree.ObjectTree)
	tree.Lock()
	defer tree.Unlock()

	var creds []*CredentialPayload

	err := tree.IterateRoot(
		// convert: decrypted bytes → CredentialPayload
		func(change *objecttree.Change, decrypted []byte) (any, error) {
			if len(decrypted) == 0 {
				return nil, nil
			}
			var p CredentialPayload
			if err := json.Unmarshal(decrypted, &p); err != nil {
				return nil, fmt.Errorf("unmarshaling credential: %w", err)
			}
			return &p, nil
		},
		// iterate: collect all converted models
		func(change *objecttree.Change) bool {
			if change.Model == nil {
				return true
			}
			if c, ok := change.Model.(*CredentialPayload); ok {
				creds = append(creds, c)
			}
			return true
		},
	)
	if err != nil {
		return nil, fmt.Errorf("iterating tree: %w", err)
	}

	return creds, nil
}

// GetTreeID returns the ID of the credential tree for a space, or empty string if none.
func (m *CredentialTreeManager) GetTreeID(spaceID string) string {
	val, ok := m.trees.Load(spaceID)
	if !ok {
		return ""
	}
	tree := val.(objecttree.ObjectTree)
	return tree.Id()
}

// discoverTree discovers and loads a credential tree from the space storage.
// This is used when another peer created the tree and it was synced via tree nodes.
func (m *CredentialTreeManager) discoverTree(ctx context.Context, spaceID string) error {
	space, err := m.client.GetSpace(ctx, spaceID)
	if err != nil {
		return fmt.Errorf("getting space: %w", err)
	}

	storedIds := space.StoredIds()
	builder := space.TreeBuilder()

	for _, treeID := range storedIds {
		tree, err := builder.BuildTree(ctx, treeID, objecttreebuilder.BuildTreeOpts{})
		if err != nil {
			continue
		}
		// Check if this is a credential tree by inspecting change types.
		// Root changes store the type in Model.(*TreeChangeInfo).ChangeType,
		// while non-root changes store it in Change.DataType.
		tree.Lock()
		isCredTree := false
		_ = tree.IterateRoot(
			func(change *objecttree.Change, decrypted []byte) (any, error) {
				return nil, nil
			},
			func(change *objecttree.Change) bool {
				if change.DataType == CredentialChangeType {
					isCredTree = true
					return false
				}
				// Check root change's ChangeType via Model
				if info, ok := change.Model.(*treechangeproto.TreeChangeInfo); ok {
					if info.ChangeType == CredentialChangeType {
						isCredTree = true
						return false
					}
				}
				return true
			},
		)
		tree.Unlock()
		if isCredTree {
			m.trees.Store(spaceID, tree)
			return nil
		}
	}
	return fmt.Errorf("no credential tree found in %d stored objects", len(storedIds))
}

// getOrCreateTree returns the existing credential tree for a space, or creates one.
func (m *CredentialTreeManager) getOrCreateTree(ctx context.Context, spaceID string, signingKey crypto.PrivKey) (objecttree.ObjectTree, error) {
	if val, ok := m.trees.Load(spaceID); ok {
		return val.(objecttree.ObjectTree), nil
	}

	_, err := m.CreateCredentialTree(ctx, spaceID, signingKey)
	if err != nil {
		return nil, err
	}

	val, ok := m.trees.Load(spaceID)
	if !ok {
		return nil, fmt.Errorf("tree not found after creation for space %s", spaceID)
	}

	return val.(objecttree.ObjectTree), nil
}
