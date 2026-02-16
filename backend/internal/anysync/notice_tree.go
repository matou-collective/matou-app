// Package anysync provides any-sync integration for MATOU.
// notice_tree.go manages notice and interaction storage using a tree-per-object model.
// Each notice gets its own ObjectTree (changeType: matou.notice.v1).
// Each interaction (ack, rsvp, save) gets its own ObjectTree (changeType: matou.interaction.v1).
// RSVP uses last-write-wins via unique objectID: "RSVP-{noticeId}-{userId}".
package anysync

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/anyproto/any-sync/commonspace/object/tree/objecttree"
	"github.com/anyproto/any-sync/util/crypto"
)

// NoticePayload is the API-level representation of a notice.
type NoticePayload struct {
	ID               string          `json:"id"`
	Type             string          `json:"type"`     // "event" or "update"
	Subtype          string          `json:"subtype,omitempty"`
	Title            string          `json:"title"`
	Summary          string          `json:"summary"`
	Body             string          `json:"body,omitempty"`
	Links            json.RawMessage `json:"links,omitempty"`
	IssuerType       string          `json:"issuerType"`
	IssuerID         string          `json:"issuerId"`
	IssuerName       string          `json:"issuerDisplayName,omitempty"`
	AudienceMode     string          `json:"audienceMode,omitempty"`
	AudienceRoleIDs  json.RawMessage `json:"audienceRoleIds,omitempty"`
	PublishAt        string          `json:"publishAt,omitempty"`
	ActiveFrom       string          `json:"activeFrom,omitempty"`
	ActiveUntil      string          `json:"activeUntil,omitempty"`
	EventStart       string          `json:"eventStart,omitempty"`
	EventEnd         string          `json:"eventEnd,omitempty"`
	Timezone         string          `json:"timezone,omitempty"`
	LocationMode     string          `json:"locationMode,omitempty"`
	LocationText     string          `json:"locationText,omitempty"`
	LocationURL      string          `json:"locationUrl,omitempty"`
	RSVPEnabled      bool            `json:"rsvpEnabled,omitempty"`
	RSVPRequired     bool            `json:"rsvpRequired,omitempty"`
	RSVPCapacity     int             `json:"rsvpCapacity,omitempty"`
	AckRequired      bool            `json:"ackRequired,omitempty"`
	AckDueAt         string          `json:"ackDueAt,omitempty"`
	State            string          `json:"state"` // "draft", "published", "archived"
	CreatedAt        string          `json:"createdAt"`
	CreatedBy        string          `json:"createdBy"`
	PublishedAt      string          `json:"publishedAt,omitempty"`
	ArchivedAt       string          `json:"archivedAt,omitempty"`
	AmendsNoticeID   string          `json:"amendsNoticeId,omitempty"`
	TreeID           string          `json:"treeId,omitempty"`
}

// NoticeAckPayload represents an acknowledgment of a notice.
type NoticeAckPayload struct {
	ID       string `json:"id"`
	NoticeID string `json:"noticeId"`
	UserID   string `json:"userId"`
	AckAt    string `json:"ackAt"`
	Method   string `json:"method"` // "open" or "explicit"
	TreeID   string `json:"treeId,omitempty"`
}

// NoticeRSVPPayload represents an RSVP response to a notice.
type NoticeRSVPPayload struct {
	ID        string `json:"id"`
	NoticeID  string `json:"noticeId"`
	UserID    string `json:"userId"`
	Status    string `json:"status"` // "going", "maybe", "not_going"
	UpdatedAt string `json:"updatedAt"`
	TreeID    string `json:"treeId,omitempty"`
}

// NoticeSavePayload represents a saved/pinned notice bookmark.
type NoticeSavePayload struct {
	ID       string `json:"id"`
	NoticeID string `json:"noticeId"`
	UserID   string `json:"userId"`
	SavedAt  string `json:"savedAt"`
	Pinned   bool   `json:"pinned"`
	TreeID   string `json:"treeId,omitempty"`
}

// NoticeTreeManager manages notice and interaction storage using tree-per-object model.
type NoticeTreeManager struct {
	client      AnySyncClient
	keyManager  *PeerKeyManager
	treeManager *UnifiedTreeManager
}

// NewNoticeTreeManager creates a new NoticeTreeManager backed by UnifiedTreeManager.
func NewNoticeTreeManager(client AnySyncClient, keyManager *PeerKeyManager, treeManager *UnifiedTreeManager) *NoticeTreeManager {
	return &NoticeTreeManager{
		client:      client,
		keyManager:  keyManager,
		treeManager: treeManager,
	}
}

// CreateNotice creates a new notice tree with initial field values.
func (m *NoticeTreeManager) CreateNotice(ctx context.Context, spaceID string, notice *NoticePayload, signingKey crypto.PrivKey) (string, error) {
	objectID := fmt.Sprintf("Notice-%s", notice.ID)

	tree, treeID, err := m.treeManager.CreateObjectTree(ctx, spaceID, objectID, "Notice", NoticeTreeType, signingKey)
	if err != nil {
		return "", fmt.Errorf("creating notice tree: %w", err)
	}

	fields := noticeToFields(notice)
	initOps := InitChange(fields)
	data, err := json.Marshal(initOps)
	if err != nil {
		return "", fmt.Errorf("marshaling notice change: %w", err)
	}

	tree.Lock()
	defer tree.Unlock()

	result, err := tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        true,
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          ObjectChangeType,
	})
	if err != nil {
		return "", fmt.Errorf("adding notice content: %w", err)
	}

	if len(result.Heads) == 0 {
		return "", fmt.Errorf("no heads returned after adding notice")
	}

	log.Printf("[NoticeTree] Created notice %s (type=%s, state=%s) treeId=%s space=%s",
		notice.ID, notice.Type, notice.State, treeID, spaceID)

	return treeID, nil
}

// UpdateNoticeState transitions a notice to a new lifecycle state.
func (m *NoticeTreeManager) UpdateNoticeState(ctx context.Context, spaceID, noticeID, newState string, signingKey crypto.PrivKey) error {
	objectID := fmt.Sprintf("Notice-%s", noticeID)

	tree, err := m.treeManager.GetTreeForObject(ctx, spaceID, objectID)
	if err != nil {
		return fmt.Errorf("notice %s not found: %w", noticeID, err)
	}

	tree.Lock()
	defer tree.Unlock()

	// Build current state to verify transition is valid
	state, err := BuildState(tree, objectID, "Notice")
	if err != nil {
		return fmt.Errorf("building state for notice %s: %w", noticeID, err)
	}

	// Extract current state from fields
	var currentState string
	if v, ok := state.Fields["state"]; ok {
		json.Unmarshal(v, &currentState)
	}

	// Build update change
	now := time.Now().UTC().Format(time.RFC3339)
	fields := map[string]json.RawMessage{}

	stateJSON, _ := json.Marshal(newState)
	fields["state"] = stateJSON

	switch newState {
	case "published":
		publishedAt, _ := json.Marshal(now)
		fields["publishedAt"] = publishedAt
		if _, ok := state.Fields["publishAt"]; !ok {
			fields["publishAt"] = publishedAt
		}
	case "archived":
		archivedAt, _ := json.Marshal(now)
		fields["archivedAt"] = archivedAt
	}

	diff := DiffState(state, mergeFields(state.Fields, fields))
	if diff == nil {
		return nil // no changes
	}

	data, err := json.Marshal(diff)
	if err != nil {
		return fmt.Errorf("marshaling state transition: %w", err)
	}

	_, err = tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        false,
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          ObjectChangeType,
	})
	if err != nil {
		return fmt.Errorf("adding state transition: %w", err)
	}

	log.Printf("[NoticeTree] Transitioned notice %s: %s -> %s", noticeID, currentState, newState)
	return nil
}

// ReadNotices reads all notices from a space.
func (m *NoticeTreeManager) ReadNotices(ctx context.Context, spaceID string) ([]*NoticePayload, error) {
	entries := m.treeManager.GetTreesByChangeType(spaceID, NoticeTreeType)

	var notices []*NoticePayload
	for _, entry := range entries {
		tree, err := m.treeManager.GetTree(ctx, spaceID, entry.TreeID)
		if err != nil {
			continue
		}

		notice, err := m.readNoticeFromTree(tree, entry)
		if err != nil {
			log.Printf("[NoticeTree] Warning: failed to read notice from tree %s: %v",
				entry.TreeID, err)
			continue
		}

		notices = append(notices, notice)
	}

	return notices, nil
}

// ReadNotice reads a single notice by ID.
func (m *NoticeTreeManager) ReadNotice(ctx context.Context, spaceID, noticeID string) (*NoticePayload, error) {
	objectID := fmt.Sprintf("Notice-%s", noticeID)
	tree, err := m.treeManager.GetTreeForObject(ctx, spaceID, objectID)
	if err != nil {
		return nil, fmt.Errorf("notice %s not found: %w", noticeID, err)
	}

	entry := ObjectIndexEntry{
		TreeID:     tree.Id(),
		ObjectID:   objectID,
		ObjectType: "Notice",
	}

	return m.readNoticeFromTree(tree, entry)
}

// CreateRSVP creates or updates an RSVP for a notice.
// Uses objectID "RSVP-{noticeId}-{userId}" for last-write-wins semantics.
func (m *NoticeTreeManager) CreateRSVP(ctx context.Context, spaceID string, rsvp *NoticeRSVPPayload, signingKey crypto.PrivKey) (string, error) {
	objectID := fmt.Sprintf("RSVP-%s-%s", rsvp.NoticeID, rsvp.UserID)

	// Check if RSVP tree already exists (update case)
	existingTree, _ := m.treeManager.GetTreeForObject(ctx, spaceID, objectID)
	if existingTree != nil {
		return m.updateRSVP(ctx, existingTree, objectID, rsvp, signingKey)
	}

	// Create new RSVP tree
	tree, treeID, err := m.treeManager.CreateObjectTree(ctx, spaceID, objectID, "NoticeRSVP", InteractionTreeType, signingKey)
	if err != nil {
		return "", fmt.Errorf("creating RSVP tree: %w", err)
	}

	fields := rsvpToFields(rsvp)
	initOps := InitChange(fields)
	data, err := json.Marshal(initOps)
	if err != nil {
		return "", fmt.Errorf("marshaling RSVP: %w", err)
	}

	tree.Lock()
	defer tree.Unlock()

	_, err = tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        true,
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          ObjectChangeType,
	})
	if err != nil {
		return "", fmt.Errorf("adding RSVP content: %w", err)
	}

	log.Printf("[NoticeTree] Created RSVP for notice %s user %s (status=%s) treeId=%s",
		rsvp.NoticeID, rsvp.UserID, rsvp.Status, treeID)
	return treeID, nil
}

// ReadRSVPs reads all RSVPs for a specific notice.
func (m *NoticeTreeManager) ReadRSVPs(ctx context.Context, spaceID, noticeID string) ([]*NoticeRSVPPayload, error) {
	entries := m.treeManager.GetTreesByChangeType(spaceID, InteractionTreeType)

	var rsvps []*NoticeRSVPPayload
	for _, entry := range entries {
		if entry.ObjectType != "NoticeRSVP" {
			continue
		}

		tree, err := m.treeManager.GetTree(ctx, spaceID, entry.TreeID)
		if err != nil {
			continue
		}

		tree.Lock()
		state, err := BuildState(tree, entry.ObjectID, "NoticeRSVP")
		tree.Unlock()
		if err != nil {
			continue
		}

		rsvp := stateToRSVP(state, entry.TreeID)
		if rsvp.NoticeID == noticeID {
			rsvps = append(rsvps, rsvp)
		}
	}

	return rsvps, nil
}

// CreateAck creates an acknowledgment for a notice.
func (m *NoticeTreeManager) CreateAck(ctx context.Context, spaceID string, ack *NoticeAckPayload, signingKey crypto.PrivKey) (string, error) {
	objectID := fmt.Sprintf("Ack-%s-%s", ack.NoticeID, ack.UserID)

	// Check if already acked (idempotent)
	if _, err := m.treeManager.GetTreeForObject(ctx, spaceID, objectID); err == nil {
		return "", nil // already acked
	}

	tree, treeID, err := m.treeManager.CreateObjectTree(ctx, spaceID, objectID, "NoticeAck", InteractionTreeType, signingKey)
	if err != nil {
		return "", fmt.Errorf("creating ack tree: %w", err)
	}

	fields := ackToFields(ack)
	initOps := InitChange(fields)
	data, err := json.Marshal(initOps)
	if err != nil {
		return "", fmt.Errorf("marshaling ack: %w", err)
	}

	tree.Lock()
	defer tree.Unlock()

	_, err = tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        true,
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          ObjectChangeType,
	})
	if err != nil {
		return "", fmt.Errorf("adding ack content: %w", err)
	}

	log.Printf("[NoticeTree] Created ack for notice %s user %s treeId=%s", ack.NoticeID, ack.UserID, treeID)
	return treeID, nil
}

// ReadAcks reads all acks for a specific notice.
func (m *NoticeTreeManager) ReadAcks(ctx context.Context, spaceID, noticeID string) ([]*NoticeAckPayload, error) {
	entries := m.treeManager.GetTreesByChangeType(spaceID, InteractionTreeType)

	var acks []*NoticeAckPayload
	for _, entry := range entries {
		if entry.ObjectType != "NoticeAck" {
			continue
		}

		tree, err := m.treeManager.GetTree(ctx, spaceID, entry.TreeID)
		if err != nil {
			continue
		}

		tree.Lock()
		state, err := BuildState(tree, entry.ObjectID, "NoticeAck")
		tree.Unlock()
		if err != nil {
			continue
		}

		ack := stateToAck(state, entry.TreeID)
		if ack.NoticeID == noticeID {
			acks = append(acks, ack)
		}
	}

	return acks, nil
}

// CreateSave creates or removes a save/pin for a notice in the user's personal space.
func (m *NoticeTreeManager) CreateSave(ctx context.Context, spaceID string, save *NoticeSavePayload, signingKey crypto.PrivKey) (string, error) {
	objectID := fmt.Sprintf("Save-%s-%s", save.NoticeID, save.UserID)

	// Check if save tree already exists (toggle case)
	existingTree, _ := m.treeManager.GetTreeForObject(ctx, spaceID, objectID)
	if existingTree != nil {
		return m.updateSave(ctx, existingTree, objectID, save, signingKey)
	}

	tree, treeID, err := m.treeManager.CreateObjectTree(ctx, spaceID, objectID, "NoticeSave", InteractionTreeType, signingKey)
	if err != nil {
		return "", fmt.Errorf("creating save tree: %w", err)
	}

	fields := saveToFields(save)
	initOps := InitChange(fields)
	data, err := json.Marshal(initOps)
	if err != nil {
		return "", fmt.Errorf("marshaling save: %w", err)
	}

	tree.Lock()
	defer tree.Unlock()

	_, err = tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        true,
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          ObjectChangeType,
	})
	if err != nil {
		return "", fmt.Errorf("adding save content: %w", err)
	}

	log.Printf("[NoticeTree] Created save for notice %s user %s treeId=%s", save.NoticeID, save.UserID, treeID)
	return treeID, nil
}

// ReadSaves reads all saves for a user from their personal space.
func (m *NoticeTreeManager) ReadSaves(ctx context.Context, spaceID string) ([]*NoticeSavePayload, error) {
	entries := m.treeManager.GetTreesByChangeType(spaceID, InteractionTreeType)

	var saves []*NoticeSavePayload
	for _, entry := range entries {
		if entry.ObjectType != "NoticeSave" {
			continue
		}

		tree, err := m.treeManager.GetTree(ctx, spaceID, entry.TreeID)
		if err != nil {
			continue
		}

		tree.Lock()
		state, err := BuildState(tree, entry.ObjectID, "NoticeSave")
		tree.Unlock()
		if err != nil {
			continue
		}

		save := stateToSave(state, entry.TreeID)
		saves = append(saves, save)
	}

	return saves, nil
}

// --- Internal helpers ---

func (m *NoticeTreeManager) readNoticeFromTree(tree objecttree.ObjectTree, entry ObjectIndexEntry) (*NoticePayload, error) {
	tree.Lock()
	state, err := BuildState(tree, entry.ObjectID, entry.ObjectType)
	tree.Unlock()
	if err != nil {
		return nil, err
	}

	return stateToNotice(state, tree.Id())
}

func (m *NoticeTreeManager) updateRSVP(ctx context.Context, tree objecttree.ObjectTree, objectID string, rsvp *NoticeRSVPPayload, signingKey crypto.PrivKey) (string, error) {
	tree.Lock()
	defer tree.Unlock()

	state, err := BuildState(tree, objectID, "NoticeRSVP")
	if err != nil {
		return "", fmt.Errorf("building RSVP state: %w", err)
	}

	newFields := rsvpToFields(rsvp)
	diff := DiffState(state, newFields)
	if diff == nil {
		return "", nil
	}

	data, err := json.Marshal(diff)
	if err != nil {
		return "", fmt.Errorf("marshaling RSVP update: %w", err)
	}

	_, err = tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        false,
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          ObjectChangeType,
	})
	if err != nil {
		return "", fmt.Errorf("updating RSVP: %w", err)
	}

	log.Printf("[NoticeTree] Updated RSVP %s status=%s", objectID, rsvp.Status)
	return tree.Id(), nil
}

func (m *NoticeTreeManager) updateSave(ctx context.Context, tree objecttree.ObjectTree, objectID string, save *NoticeSavePayload, signingKey crypto.PrivKey) (string, error) {
	tree.Lock()
	defer tree.Unlock()

	state, err := BuildState(tree, objectID, "NoticeSave")
	if err != nil {
		return "", fmt.Errorf("building save state: %w", err)
	}

	newFields := saveToFields(save)
	diff := DiffState(state, newFields)
	if diff == nil {
		return "", nil
	}

	data, err := json.Marshal(diff)
	if err != nil {
		return "", fmt.Errorf("marshaling save update: %w", err)
	}

	_, err = tree.AddContent(ctx, objecttree.SignableChangeContent{
		Data:              data,
		Key:               signingKey,
		IsSnapshot:        false,
		ShouldBeEncrypted: true,
		Timestamp:         time.Now().Unix(),
		DataType:          ObjectChangeType,
	})
	if err != nil {
		return "", fmt.Errorf("updating save: %w", err)
	}

	log.Printf("[NoticeTree] Updated save %s pinned=%v", objectID, save.Pinned)
	return tree.Id(), nil
}

// mergeFields merges new fields into existing fields, returning a combined map.
func mergeFields(existing, updates map[string]json.RawMessage) map[string]json.RawMessage {
	merged := make(map[string]json.RawMessage, len(existing)+len(updates))
	for k, v := range existing {
		merged[k] = v
	}
	for k, v := range updates {
		merged[k] = v
	}
	return merged
}

// --- Field conversion helpers ---

func noticeToFields(n *NoticePayload) map[string]json.RawMessage {
	fields := make(map[string]json.RawMessage)
	setField(fields, "type", n.Type)
	setField(fields, "title", n.Title)
	setField(fields, "summary", n.Summary)
	setField(fields, "state", n.State)
	setField(fields, "createdAt", n.CreatedAt)
	setField(fields, "createdBy", n.CreatedBy)
	setField(fields, "issuerType", n.IssuerType)
	setField(fields, "issuerId", n.IssuerID)

	if n.Subtype != "" {
		setField(fields, "subtype", n.Subtype)
	}
	if n.Body != "" {
		setField(fields, "body", n.Body)
	}
	if len(n.Links) > 0 {
		fields["links"] = n.Links
	}
	if n.IssuerName != "" {
		setField(fields, "issuerDisplayName", n.IssuerName)
	}
	if n.AudienceMode != "" {
		setField(fields, "audienceMode", n.AudienceMode)
	}
	if len(n.AudienceRoleIDs) > 0 {
		fields["audienceRoleIds"] = n.AudienceRoleIDs
	}
	if n.PublishAt != "" {
		setField(fields, "publishAt", n.PublishAt)
	}
	if n.ActiveFrom != "" {
		setField(fields, "activeFrom", n.ActiveFrom)
	}
	if n.ActiveUntil != "" {
		setField(fields, "activeUntil", n.ActiveUntil)
	}
	if n.EventStart != "" {
		setField(fields, "eventStart", n.EventStart)
	}
	if n.EventEnd != "" {
		setField(fields, "eventEnd", n.EventEnd)
	}
	if n.Timezone != "" {
		setField(fields, "timezone", n.Timezone)
	}
	if n.LocationMode != "" {
		setField(fields, "locationMode", n.LocationMode)
	}
	if n.LocationText != "" {
		setField(fields, "locationText", n.LocationText)
	}
	if n.LocationURL != "" {
		setField(fields, "locationUrl", n.LocationURL)
	}
	if n.RSVPEnabled {
		setField(fields, "rsvpEnabled", true)
	}
	if n.RSVPRequired {
		setField(fields, "rsvpRequired", true)
	}
	if n.RSVPCapacity > 0 {
		setField(fields, "rsvpCapacity", n.RSVPCapacity)
	}
	if n.AckRequired {
		setField(fields, "ackRequired", true)
	}
	if n.AckDueAt != "" {
		setField(fields, "ackDueAt", n.AckDueAt)
	}
	if n.PublishedAt != "" {
		setField(fields, "publishedAt", n.PublishedAt)
	}
	if n.ArchivedAt != "" {
		setField(fields, "archivedAt", n.ArchivedAt)
	}
	if n.AmendsNoticeID != "" {
		setField(fields, "amendsNoticeId", n.AmendsNoticeID)
	}

	return fields
}

func rsvpToFields(r *NoticeRSVPPayload) map[string]json.RawMessage {
	fields := make(map[string]json.RawMessage)
	setField(fields, "noticeId", r.NoticeID)
	setField(fields, "userId", r.UserID)
	setField(fields, "status", r.Status)
	setField(fields, "updatedAt", r.UpdatedAt)
	return fields
}

func ackToFields(a *NoticeAckPayload) map[string]json.RawMessage {
	fields := make(map[string]json.RawMessage)
	setField(fields, "noticeId", a.NoticeID)
	setField(fields, "userId", a.UserID)
	setField(fields, "ackAt", a.AckAt)
	setField(fields, "method", a.Method)
	return fields
}

func saveToFields(s *NoticeSavePayload) map[string]json.RawMessage {
	fields := make(map[string]json.RawMessage)
	setField(fields, "noticeId", s.NoticeID)
	setField(fields, "userId", s.UserID)
	setField(fields, "savedAt", s.SavedAt)
	setField(fields, "pinned", s.Pinned)
	return fields
}

func setField(fields map[string]json.RawMessage, key string, value interface{}) {
	b, err := json.Marshal(value)
	if err == nil {
		fields[key] = b
	}
}

// --- State conversion helpers ---

func stateToNotice(state *ObjectState, treeID string) (*NoticePayload, error) {
	n := &NoticePayload{
		ID:     state.ObjectID,
		TreeID: treeID,
	}
	// Strip "Notice-" prefix from ObjectID
	if len(n.ID) > 7 && n.ID[:7] == "Notice-" {
		n.ID = n.ID[7:]
	}

	getStringField(state.Fields, "type", &n.Type)
	getStringField(state.Fields, "subtype", &n.Subtype)
	getStringField(state.Fields, "title", &n.Title)
	getStringField(state.Fields, "summary", &n.Summary)
	getStringField(state.Fields, "body", &n.Body)
	if v, ok := state.Fields["links"]; ok {
		n.Links = v
	}
	getStringField(state.Fields, "issuerType", &n.IssuerType)
	getStringField(state.Fields, "issuerId", &n.IssuerID)
	getStringField(state.Fields, "issuerDisplayName", &n.IssuerName)
	getStringField(state.Fields, "audienceMode", &n.AudienceMode)
	if v, ok := state.Fields["audienceRoleIds"]; ok {
		n.AudienceRoleIDs = v
	}
	getStringField(state.Fields, "publishAt", &n.PublishAt)
	getStringField(state.Fields, "activeFrom", &n.ActiveFrom)
	getStringField(state.Fields, "activeUntil", &n.ActiveUntil)
	getStringField(state.Fields, "eventStart", &n.EventStart)
	getStringField(state.Fields, "eventEnd", &n.EventEnd)
	getStringField(state.Fields, "timezone", &n.Timezone)
	getStringField(state.Fields, "locationMode", &n.LocationMode)
	getStringField(state.Fields, "locationText", &n.LocationText)
	getStringField(state.Fields, "locationUrl", &n.LocationURL)
	getBoolField(state.Fields, "rsvpEnabled", &n.RSVPEnabled)
	getBoolField(state.Fields, "rsvpRequired", &n.RSVPRequired)
	getIntField(state.Fields, "rsvpCapacity", &n.RSVPCapacity)
	getBoolField(state.Fields, "ackRequired", &n.AckRequired)
	getStringField(state.Fields, "ackDueAt", &n.AckDueAt)
	getStringField(state.Fields, "state", &n.State)
	getStringField(state.Fields, "createdAt", &n.CreatedAt)
	getStringField(state.Fields, "createdBy", &n.CreatedBy)
	getStringField(state.Fields, "publishedAt", &n.PublishedAt)
	getStringField(state.Fields, "archivedAt", &n.ArchivedAt)
	getStringField(state.Fields, "amendsNoticeId", &n.AmendsNoticeID)

	return n, nil
}

func stateToRSVP(state *ObjectState, treeID string) *NoticeRSVPPayload {
	r := &NoticeRSVPPayload{
		ID:     state.ObjectID,
		TreeID: treeID,
	}
	getStringField(state.Fields, "noticeId", &r.NoticeID)
	getStringField(state.Fields, "userId", &r.UserID)
	getStringField(state.Fields, "status", &r.Status)
	getStringField(state.Fields, "updatedAt", &r.UpdatedAt)
	return r
}

func stateToAck(state *ObjectState, treeID string) *NoticeAckPayload {
	a := &NoticeAckPayload{
		ID:     state.ObjectID,
		TreeID: treeID,
	}
	getStringField(state.Fields, "noticeId", &a.NoticeID)
	getStringField(state.Fields, "userId", &a.UserID)
	getStringField(state.Fields, "ackAt", &a.AckAt)
	getStringField(state.Fields, "method", &a.Method)
	return a
}

func stateToSave(state *ObjectState, treeID string) *NoticeSavePayload {
	s := &NoticeSavePayload{
		ID:     state.ObjectID,
		TreeID: treeID,
	}
	getStringField(state.Fields, "noticeId", &s.NoticeID)
	getStringField(state.Fields, "userId", &s.UserID)
	getStringField(state.Fields, "savedAt", &s.SavedAt)
	getBoolField(state.Fields, "pinned", &s.Pinned)
	return s
}

func getStringField(fields map[string]json.RawMessage, key string, target *string) {
	if v, ok := fields[key]; ok {
		json.Unmarshal(v, target)
	}
}

func getBoolField(fields map[string]json.RawMessage, key string, target *bool) {
	if v, ok := fields[key]; ok {
		json.Unmarshal(v, target)
	}
}

func getIntField(fields map[string]json.RawMessage, key string, target *int) {
	if v, ok := fields[key]; ok {
		json.Unmarshal(v, target)
	}
}
