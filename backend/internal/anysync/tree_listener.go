package anysync

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/commonspace/object/tree/treechangeproto"
)

// ChatPersister is the interface for persisting chat objects to a store.
// The implementation (in cmd/server) handles the conversion from ObjectPayload
// to store-specific types, avoiding circular imports.
type ChatPersister interface {
	PersistChatObject(ctx context.Context, payload *ObjectPayload) error
}

// SSEEvent matches the api.SSEEvent structure. Defined here to avoid
// circular imports (anysync cannot import api).
type SSEEvent struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// EventBroadcaster is the interface for emitting SSE events.
type EventBroadcaster interface {
	Broadcast(event SSEEvent)
}

// TreeUpdateListener implements updatelistener.UpdateListener.
// It persists CRDT tree changes to a store and emits SSE events.
type TreeUpdateListener struct {
	mu        sync.Mutex
	persister ChatPersister
	broker    EventBroadcaster
	seeded    bool
	known     map[string]int // objectID → version
}

// NewTreeUpdateListener creates a new TreeUpdateListener.
func NewTreeUpdateListener(persister ChatPersister, broker EventBroadcaster) *TreeUpdateListener {
	return &TreeUpdateListener{
		persister: persister,
		broker:    broker,
		known:     make(map[string]int),
	}
}

// Update is called when the tree receives new changes from peers.
// The tree lock is already held by the caller — safe to call IterateRoot.
func (l *TreeUpdateListener) Update(tree objecttree.ObjectTree) error {
	return l.processChanges(tree)
}

// Rebuild is called when the tree is fully rebuilt (e.g. on initial build).
// The tree lock is already held by the caller — safe to call IterateRoot.
func (l *TreeUpdateListener) Rebuild(tree objecttree.ObjectTree) error {
	return l.processChanges(tree)
}

// RegisterObject records a locally-written object so the next P2P callback
// doesn't emit a spurious SSE event. Also persists to the store immediately.
func (l *TreeUpdateListener) RegisterObject(payload *ObjectPayload) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.known[payload.ID] = payload.Version

	if l.persister != nil {
		ctx := context.Background()
		if err := l.persister.PersistChatObject(ctx, payload); err != nil {
			fmt.Printf("[TreeUpdateListener] RegisterObject persist failed for %s: %v\n", payload.ID, err)
		}
	}
}

// processChanges reconstructs the object state from the tree using BuildState
// and emits SSE events for new/changed objects.
func (l *TreeUpdateListener) processChanges(tree objecttree.ObjectTree) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	wasSeeded := l.seeded
	ctx := context.Background()

	// Extract objectID and objectType from tree root header
	objectID, objectType := l.extractRootHeader(tree)
	if objectID == "" {
		// Not a MATOU object tree, skip
		l.seeded = true
		return nil
	}

	// Only process chat types — profiles/credentials are handled elsewhere
	switch objectType {
	case "ChatChannel", "ChatMessage", "MessageReaction":
		// proceed
	default:
		l.seeded = true
		return nil
	}

	// Build the full state from the tree (tree lock is held by caller)
	state, err := BuildState(tree, objectID, objectType)
	if err != nil {
		log.Printf("[TreeUpdateListener] BuildState failed for %s: %v", objectID, err)
		l.seeded = true
		return nil
	}

	// Check if this is new/changed
	knownVer, exists := l.known[objectID]
	if exists && state.Version <= knownVer {
		l.seeded = true
		return nil // already processed this version
	}

	// Update known version
	l.known[objectID] = state.Version

	// Convert state to payload
	p := stateToPayload(state, tree.Id())

	// Persist to store
	if l.persister != nil {
		if err := l.persister.PersistChatObject(ctx, p); err != nil {
			fmt.Printf("[TreeUpdateListener] persist failed for %s: %v\n", p.ID, err)
		}
	}

	// Emit SSE only after initial seed and only for genuinely new/changed objects
	if wasSeeded && l.broker != nil {
		l.emitSSE(p, exists)
	}

	l.seeded = true
	return nil
}

// extractRootHeader parses the tree's root change to get the objectID and objectType.
func (l *TreeUpdateListener) extractRootHeader(tree objecttree.ObjectTree) (objectID, objectType string) {
	rawHeader := tree.Header()
	if rawHeader == nil || len(rawHeader.RawChange) == 0 {
		return "", ""
	}

	var rawTreeCh treechangeproto.RawTreeChange
	if err := rawTreeCh.UnmarshalVT(rawHeader.RawChange); err != nil {
		return "", ""
	}

	var rootCh treechangeproto.RootChange
	if err := rootCh.UnmarshalVT(rawTreeCh.Payload); err != nil {
		return "", ""
	}

	if len(rootCh.ChangePayload) == 0 {
		return "", ""
	}

	var header TreeRootHeader
	if err := json.Unmarshal(rootCh.ChangePayload, &header); err != nil {
		return "", ""
	}

	return header.ObjectID, header.ObjectType
}

// emitSSE broadcasts an SSE event for a changed object.
func (l *TreeUpdateListener) emitSSE(p *ObjectPayload, existed bool) {
	switch p.Type {
	case "ChatChannel":
		eventType := "chat:channel:new"
		if existed {
			eventType = "chat:channel:update"
		}
		l.broker.Broadcast(SSEEvent{
			Type: eventType,
			Data: map[string]interface{}{"channelId": p.ID, "source": "p2p"},
		})

	case "ChatMessage":
		var data struct {
			ChannelID  string `json:"channelId"`
			SenderAID  string `json:"senderAid"`
			SenderName string `json:"senderName"`
			Content    string `json:"content"`
			SentAt     string `json:"sentAt"`
			EditedAt   string `json:"editedAt,omitempty"`
			DeletedAt  string `json:"deletedAt,omitempty"`
		}
		json.Unmarshal(p.Data, &data)

		if !existed && data.DeletedAt == "" {
			l.broker.Broadcast(SSEEvent{
				Type: "chat:message:new",
				Data: map[string]interface{}{
					"messageId":  p.ID,
					"channelId":  data.ChannelID,
					"senderAid":  data.SenderAID,
					"senderName": data.SenderName,
					"content":    data.Content,
					"sentAt":     data.SentAt,
					"source":     "p2p",
				},
			})
		} else if existed && data.DeletedAt != "" {
			l.broker.Broadcast(SSEEvent{
				Type: "chat:message:delete",
				Data: map[string]interface{}{
					"messageId": p.ID,
					"channelId": data.ChannelID,
					"deletedAt": data.DeletedAt,
					"source":    "p2p",
				},
			})
		} else if existed && data.EditedAt != "" {
			l.broker.Broadcast(SSEEvent{
				Type: "chat:message:edit",
				Data: map[string]interface{}{
					"messageId": p.ID,
					"channelId": data.ChannelID,
					"content":   data.Content,
					"editedAt":  data.EditedAt,
					"source":    "p2p",
				},
			})
		}

	case "MessageReaction":
		var data struct {
			MessageID   string   `json:"messageId"`
			Emoji       string   `json:"emoji"`
			ReactorAIDs []string `json:"reactorAids"`
		}
		json.Unmarshal(p.Data, &data)

		l.broker.Broadcast(SSEEvent{
			Type: "chat:reaction:update",
			Data: map[string]interface{}{
				"messageId": data.MessageID,
				"emoji":     data.Emoji,
				"count":     len(data.ReactorAIDs),
				"source":    "p2p",
			},
		})
	}
}
