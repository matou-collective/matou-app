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

// FreshTreeReader builds a fresh (uncached) tree from storage for reading.
// Used as a fallback when the cached tree instance has stale decryption keys.
type FreshTreeReader func(treeId string) (objecttree.ObjectTree, error)

// TreeUpdateListener implements updatelistener.UpdateListener.
// It persists CRDT tree changes to a store and emits SSE events.
type TreeUpdateListener struct {
	mu              sync.Mutex
	persister       ChatPersister
	broker          EventBroadcaster
	freshTreeReader FreshTreeReader
	validator       ChangeValidator
	seeded          bool
	known           map[string]int // objectID → version
}

// NewTreeUpdateListener creates a new TreeUpdateListener.
func NewTreeUpdateListener(persister ChatPersister, broker EventBroadcaster) *TreeUpdateListener {
	return &TreeUpdateListener{
		persister: persister,
		broker:    broker,
		known:     make(map[string]int),
	}
}

// SetFreshTreeReader sets the callback for building fresh trees when the
// cached instance can't decrypt content (stale keys from ACL timing).
func (l *TreeUpdateListener) SetFreshTreeReader(reader FreshTreeReader) {
	l.freshTreeReader = reader
}

// SetChangeValidator installs a peer-side write validator (see write_rules.go).
// When set, state reconstructed from synced trees excludes changes that violate
// the per-object-type write rules, so a forged high-stakes change from another
// peer does not alter this node's application state. A nil validator (the
// default) leaves state reconstruction unchanged.
func (l *TreeUpdateListener) SetChangeValidator(v ChangeValidator) {
	l.validator = v
}

// Update is called when the tree receives new changes from peers.
// The tree lock is already held by the caller — safe to call IterateRoot.
func (l *TreeUpdateListener) Update(tree objecttree.ObjectTree) error {
	log.Printf("[TreeUpdateListener] Update called for tree %s", tree.Id())
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

	// Profile and multisig-coordination types are processed but DO NOT use the
	// FreshTreeReader fallback — they fire frequently during initial sync
	// (before the receiver's ACL has caught up and the read key is available),
	// and the fallback's extra tree lock would contend with the JoinCommunity
	// → WaitForSync path. Best-effort state-build only; if it fails, skip
	// silently and let the next listener fire after the keyring catches up.
	isProfileType := objectType == "SharedProfile" || objectType == "CommunityProfile"
	isMultisigCoordType := objectType == "MultisigRotationSignal" || objectType == "MultisigRotationAck"

	// Only process chat, contribution, profile, and multisig-coord types
	// — credentials are handled elsewhere
	switch objectType {
	case "ChatChannel", "ChatMessage", "MessageReaction":
		// proceed with full handling (incl. FreshTreeReader fallback)
	case TypeProject, TypeImplementationPlan, TypeContribution, TypeMilestone,
		TypeProposal, TypeDecisionPlan, TypeGovernanceAction, TypeEndorsement,
		"proposal_comment", "contribution_comment", "project_comment":
		// proceed with full handling
	case "SharedProfile", "CommunityProfile":
		// proceed — peers need SSE for new registrations + role changes so the
		// UI live-updates without depending on a periodic poll. Best-effort only.
	case "MultisigRotationSignal", "MultisigRotationAck":
		// proceed — cross-client coordination for member-to-admin upgrade flow.
		// See MULTISIG-POC-FINDINGS.md item #4. Treated like profile types:
		// SSE-only, no persister, no FreshTreeReader fallback.
	default:
		l.seeded = true
		return nil
	}

	// Build the full state from the tree (tree lock is held by caller). The
	// validator excludes forged high-stakes changes from other peers.
	state, err := BuildStateValidated(tree, objectID, objectType, l.validator)
	if err != nil {
		if isProfileType || isMultisigCoordType {
			// Best-effort for profile + coord types: just skip and let a later
			// listener fire once the ACL has propagated and the read key is
			// available.
			l.seeded = true
			return nil
		}

		log.Printf("[TreeUpdateListener] BuildState failed for %s: %v (treeId=%s, len=%d), trying fresh tree",
			objectID, err, tree.Id(), tree.Len())

		// The cached tree may have been built before the ACL fully synced,
		// leaving ot.keys empty (readKeysFromAclState Guard 2 failed because
		// HadReadPermissions was false). Build a fresh tree from storage which
		// re-runs readKeysFromAclState with the current ACL state.
		if l.freshTreeReader != nil {
			freshTree, freshErr := l.freshTreeReader(tree.Id())
			if freshErr != nil {
				log.Printf("[TreeUpdateListener] FreshTreeReader failed for %s: %v", tree.Id(), freshErr)
				l.seeded = true
				return nil
			}
			freshTree.Lock()
			state, err = BuildStateValidated(freshTree, objectID, objectType, l.validator)
			freshTree.Unlock()
			if err != nil {
				log.Printf("[TreeUpdateListener] BuildState on fresh tree also failed for %s: %v", objectID, err)
				l.seeded = true
				return nil
			}
			log.Printf("[TreeUpdateListener] Fresh tree succeeded for %s (version=%d)", objectID, state.Version)
		} else {
			l.seeded = true
			return nil
		}
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

	// Persist to store — skip for profile types and multisig-coord types
	// (persister is ChatPersister; these types are SSE-only).
	if l.persister != nil && !isProfileType && !isMultisigCoordType {
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
	log.Printf("[TreeUpdateListener] emitSSE type=%s id=%s existed=%v", p.Type, p.ID, existed)
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

	case TypeProject:
		var data struct {
			Name   string `json:"name"`
			Title  string `json:"title"`
			Status string `json:"status"`
		}
		json.Unmarshal(p.Data, &data)

		// Prefer "name" field; fall back to "title" for backward compatibility.
		name := data.Name
		if name == "" {
			name = data.Title
		}

		l.broker.Broadcast(SSEEvent{
			Type: "project_updated",
			Data: map[string]interface{}{
				"treeId":     p.TreeID,
				"project_id": p.ID,
				"name":       name,
				"status":     data.Status,
				"change":     changeLabel(existed),
				"source":     "p2p",
			},
		})

	case TypeImplementationPlan:
		var data struct {
			ProjectID string `json:"project_id"`
			Status    string `json:"status"`
		}
		json.Unmarshal(p.Data, &data)

		l.broker.Broadcast(SSEEvent{
			Type: "plan_updated",
			Data: map[string]interface{}{
				"treeId":     p.TreeID,
				"plan_id":    p.ID,
				"project_id": data.ProjectID,
				"status":     data.Status,
				"change":     changeLabel(existed),
				"source":     "p2p",
			},
		})

	case TypeContribution:
		var data struct {
			ProjectID string `json:"project_id"`
			Title     string `json:"title"`
			Status    string `json:"status"`
		}
		json.Unmarshal(p.Data, &data)

		l.broker.Broadcast(SSEEvent{
			Type: "contribution_updated",
			Data: map[string]interface{}{
				"treeId":          p.TreeID,
				"contribution_id": p.ID,
				"project_id":      data.ProjectID,
				"title":           data.Title,
				"status":          data.Status,
				"change":          changeLabel(existed),
				"source":          "p2p",
			},
		})

	case TypeMilestone:
		var data struct {
			ProjectID            string `json:"project_id"`
			ImplementationPlanID string `json:"implementation_plan_id"`
			Title                string `json:"title"`
			Status               string `json:"status"`
		}
		json.Unmarshal(p.Data, &data)

		l.broker.Broadcast(SSEEvent{
			Type: "milestone_updated",
			Data: map[string]interface{}{
				"treeId":       p.TreeID,
				"milestone_id": p.ID,
				"project_id":   data.ProjectID,
				"plan_id":      data.ImplementationPlanID,
				"title":        data.Title,
				"status":       data.Status,
				"change":       changeLabel(existed),
				"source":       "p2p",
			},
		})

	case TypeProposal:
		var data struct {
			Title  string `json:"title"`
			Status string `json:"status"`
		}
		json.Unmarshal(p.Data, &data)
		l.broker.Broadcast(SSEEvent{
			Type: "proposal_updated",
			Data: map[string]interface{}{
				"treeId":      p.TreeID,
				"proposal_id": p.ID,
				"title":       data.Title,
				"status":      data.Status,
				"change":      changeLabel(existed),
				"source":      "p2p",
			},
		})

	case TypeDecisionPlan:
		var data struct {
			ProposalID string `json:"proposal_id"`
			Status     string `json:"status"`
		}
		json.Unmarshal(p.Data, &data)
		l.broker.Broadcast(SSEEvent{
			Type: "decision_plan_updated",
			Data: map[string]interface{}{
				"treeId":      p.TreeID,
				"plan_id":     p.ID,
				"proposal_id": data.ProposalID,
				"status":      data.Status,
				"change":      changeLabel(existed),
				"source":      "p2p",
			},
		})

	case TypeGovernanceAction:
		l.broker.Broadcast(SSEEvent{
			Type: "governance_action_updated",
			Data: map[string]interface{}{
				"treeId":    p.TreeID,
				"action_id": p.ID,
				"change":    changeLabel(existed),
				"source":    "p2p",
			},
		})

	case TypeEndorsement:
		var data struct {
			ProposalID string `json:"proposal_id"`
		}
		json.Unmarshal(p.Data, &data)
		l.broker.Broadcast(SSEEvent{
			Type: "proposal:endorsed",
			Data: map[string]interface{}{
				"treeId":      p.TreeID,
				"proposal_id": data.ProposalID,
				"change":      changeLabel(existed),
				"source":      "p2p",
			},
		})

	case "SharedProfile", "CommunityProfile":
		var data struct {
			AID         string `json:"aid"`
			DisplayName string `json:"displayName"`
			Status      string `json:"status"`
		}
		json.Unmarshal(p.Data, &data)
		l.broker.Broadcast(SSEEvent{
			Type: "profile:updated",
			Data: map[string]interface{}{
				"profileId":   p.ID,
				"profileType": p.Type,
				"memberAid":   data.AID,
				"displayName": data.DisplayName,
				"status":      data.Status,
				"source":      "p2p",
			},
		})

	case "MultisigRotationSignal":
		var data struct {
			AdminAid        string `json:"adminAid"`
			AdminSn         string `json:"adminSn"`
			TargetMemberAid string `json:"targetMemberAid"`
			Round           string `json:"round"`
			GroupAid        string `json:"groupAid"`
		}
		json.Unmarshal(p.Data, &data)
		l.broker.Broadcast(SSEEvent{
			Type: "multisig:rotation-signal",
			Data: map[string]interface{}{
				"signalId":        p.ID,
				"adminAid":        data.AdminAid,
				"adminSn":         data.AdminSn,
				"targetMemberAid": data.TargetMemberAid,
				"round":           data.Round,
				"groupAid":        data.GroupAid,
			},
		})

	case "MultisigRotationAck":
		var data struct {
			SignalID string `json:"signalId"`
			AdminAid string `json:"adminAid"`
			AdminSn  string `json:"adminSn"`
			AckBy    string `json:"ackBy"`
		}
		json.Unmarshal(p.Data, &data)
		l.broker.Broadcast(SSEEvent{
			Type: "multisig:rotation-ack",
			Data: map[string]interface{}{
				"objectId": p.ID,
				"signalId": data.SignalID,
				"adminAid": data.AdminAid,
				"adminSn":  data.AdminSn,
				"ackBy":    data.AckBy,
			},
		})

	case "proposal_comment":
		var data struct {
			ProposalID string `json:"proposal_id"`
		}
		json.Unmarshal(p.Data, &data)
		l.broker.Broadcast(SSEEvent{
			Type: "proposal:comment_added",
			Data: map[string]interface{}{
				"treeId":      p.TreeID,
				"proposal_id": data.ProposalID,
				"comment_id":  p.ID,
				"change":      changeLabel(existed),
				"source":      "p2p",
			},
		})

	case "contribution_comment":
		var data struct {
			ContributionID string `json:"contribution_id"`
		}
		json.Unmarshal(p.Data, &data)
		l.broker.Broadcast(SSEEvent{
			Type: "contribution:comment_added",
			Data: map[string]interface{}{
				"treeId":          p.TreeID,
				"contribution_id": data.ContributionID,
				"comment_id":      p.ID,
				"change":          changeLabel(existed),
				"source":          "p2p",
			},
		})

	case "project_comment":
		var data struct {
			ProjectID string `json:"project_id"`
		}
		json.Unmarshal(p.Data, &data)
		l.broker.Broadcast(SSEEvent{
			Type: "project:comment_added",
			Data: map[string]interface{}{
				"treeId":     p.TreeID,
				"project_id": data.ProjectID,
				"comment_id": p.ID,
				"change":     changeLabel(existed),
				"source":     "p2p",
			},
		})
	}
}

// changeLabel returns "created" when existed is false, "updated" otherwise.
// Used to label SSE events emitted for contribution system object types.
func changeLabel(existed bool) string {
	if existed {
		return "updated"
	}
	return "created"
}
