package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/identity"
)

// ChatHandler handles chat channel and message HTTP requests.
type ChatHandler struct {
	spaceManager *anysync.SpaceManager
	userIdentity *identity.UserIdentity
	eventBroker  *EventBroker
	store        *anystore.LocalStore
}

// NewChatHandler creates a new chat handler.
func NewChatHandler(
	spaceManager *anysync.SpaceManager,
	userIdentity *identity.UserIdentity,
	eventBroker *EventBroker,
	store *anystore.LocalStore,
) *ChatHandler {
	return &ChatHandler{
		spaceManager: spaceManager,
		userIdentity: userIdentity,
		eventBroker:  eventBroker,
		store:        store,
	}
}

// --- Data Types ---

// ChatChannelData represents a chat channel stored in the community space.
type ChatChannelData struct {
	Name         string   `json:"name"`
	Description  string   `json:"description,omitempty"`
	Icon         string   `json:"icon,omitempty"`
	Photo        string   `json:"photo,omitempty"`
	CreatedAt    string   `json:"createdAt"`
	CreatedBy    string   `json:"createdBy"`
	IsArchived   bool     `json:"isArchived,omitempty"`
	AllowedRoles []string `json:"allowedRoles,omitempty"`
}

// ChatMessageData represents a chat message stored in the community space.
type ChatMessageData struct {
	ChannelID   string          `json:"channelId"`
	SenderAID   string          `json:"senderAid"`
	SenderName  string          `json:"senderName"`
	Content     string          `json:"content"`
	Attachments []AttachmentRef `json:"attachments,omitempty"`
	ReplyTo     string          `json:"replyTo,omitempty"`
	SentAt      string          `json:"sentAt"`
	EditedAt    string          `json:"editedAt,omitempty"`
	DeletedAt   string          `json:"deletedAt,omitempty"`
}

// AttachmentRef represents a file attachment reference.
type AttachmentRef struct {
	FileRef     string `json:"fileRef"`
	FileName    string `json:"fileName"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
}

// MessageReactionData represents reactions on a message.
type MessageReactionData struct {
	MessageID   string   `json:"messageId"`
	Emoji       string   `json:"emoji"`
	ReactorAIDs []string `json:"reactorAids"`
}

// --- Request/Response Types ---

// CreateChannelRequest is the request body for creating a channel.
type CreateChannelRequest struct {
	Name         string   `json:"name"`
	Description  string   `json:"description,omitempty"`
	Icon         string   `json:"icon,omitempty"`
	Photo        string   `json:"photo,omitempty"`
	AllowedRoles []string `json:"allowedRoles,omitempty"`
}

// UpdateChannelRequest is the request body for updating a channel.
type UpdateChannelRequest struct {
	Name         *string   `json:"name,omitempty"`
	Description  *string   `json:"description,omitempty"`
	Icon         *string   `json:"icon,omitempty"`
	Photo        *string   `json:"photo,omitempty"`
	AllowedRoles *[]string `json:"allowedRoles,omitempty"`
}

// SendMessageRequest is the request body for sending a message.
type SendMessageRequest struct {
	Content     string          `json:"content"`
	Attachments []AttachmentRef `json:"attachments,omitempty"`
	ReplyTo     string          `json:"replyTo,omitempty"`
}

// EditMessageRequest is the request body for editing a message.
type EditMessageRequest struct {
	Content string `json:"content"`
}

// AddReactionRequest is the request body for adding a reaction.
type AddReactionRequest struct {
	Emoji string `json:"emoji"`
}

// ChannelResponse is the response for a single channel.
type ChannelResponse struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Description  string   `json:"description,omitempty"`
	Icon         string   `json:"icon,omitempty"`
	Photo        string   `json:"photo,omitempty"`
	CreatedAt    string   `json:"createdAt"`
	CreatedBy    string   `json:"createdBy"`
	IsArchived   bool     `json:"isArchived,omitempty"`
	AllowedRoles []string `json:"allowedRoles,omitempty"`
}

// MessageResponse is the response for a single message.
type MessageResponse struct {
	ID          string              `json:"id"`
	ChannelID   string              `json:"channelId"`
	SenderAID   string              `json:"senderAid"`
	SenderName  string              `json:"senderName"`
	Content     string              `json:"content"`
	Attachments []AttachmentRef     `json:"attachments,omitempty"`
	ReplyTo     string              `json:"replyTo,omitempty"`
	SentAt      string              `json:"sentAt"`
	EditedAt    string              `json:"editedAt,omitempty"`
	DeletedAt   string              `json:"deletedAt,omitempty"`
	Reactions   []ReactionAggregate `json:"reactions,omitempty"`
	Version     int                 `json:"version"`
}

// ReactionAggregate is an aggregated view of reactions for a message.
type ReactionAggregate struct {
	Emoji       string   `json:"emoji"`
	Count       int      `json:"count"`
	ReactorAIDs []string `json:"reactorAids"`
	HasReacted  bool     `json:"hasReacted"`
}

// --- Channel Handlers ---

// HandleListChannels handles GET /api/v1/chat/channels — list all channels.
func (h *ChatHandler) HandleListChannels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	ctx := r.Context()

	// Read from anystore (indexed) if available, fall back to tree scan
	if h.store != nil {
		cached, err := h.store.ListChannels(ctx)
		if err == nil {
			userRole := h.getUserRole()
			channels := make([]ChannelResponse, 0, len(cached))
			for _, ch := range cached {
				if len(ch.AllowedRoles) > 0 && !containsRole(ch.AllowedRoles, userRole) {
					continue
				}
				if ch.IsArchived && r.URL.Query().Get("includeArchived") != "true" {
					continue
				}
				channels = append(channels, ChannelResponse{
					ID:           ch.ID,
					Name:         ch.Name,
					Description:  ch.Description,
					Icon:         ch.Icon,
					Photo:        ch.Photo,
					CreatedAt:    ch.CreatedAt,
					CreatedBy:    ch.CreatedBy,
					IsArchived:   ch.IsArchived,
					AllowedRoles: ch.AllowedRoles,
				})
			}
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"channels": channels,
				"count":    len(channels),
			})
			return
		}
	}

	// Fallback: tree scan
	objMgr := h.spaceManager.ObjectTreeManager()
	objects, err := objMgr.ReadObjectsByType(ctx, communitySpaceID, "ChatChannel")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read channels: %v", err),
		})
		return
	}

	userRole := h.getUserRole()
	type channelEntry struct {
		obj  *anysync.ObjectPayload
		data ChatChannelData
	}
	latestByID := make(map[string]*channelEntry)
	for _, obj := range objects {
		var data ChatChannelData
		if err := json.Unmarshal(obj.Data, &data); err != nil {
			continue
		}
		if existing, ok := latestByID[obj.ID]; !ok || obj.Version > existing.obj.Version {
			latestByID[obj.ID] = &channelEntry{obj: obj, data: data}
		}
	}

	channels := make([]ChannelResponse, 0, len(latestByID))
	for _, entry := range latestByID {
		if len(entry.data.AllowedRoles) > 0 && !containsRole(entry.data.AllowedRoles, userRole) {
			continue
		}
		if entry.data.IsArchived && r.URL.Query().Get("includeArchived") != "true" {
			continue
		}
		channels = append(channels, ChannelResponse{
			ID:           entry.obj.ID,
			Name:         entry.data.Name,
			Description:  entry.data.Description,
			Icon:         entry.data.Icon,
			Photo:        entry.data.Photo,
			CreatedAt:    entry.data.CreatedAt,
			CreatedBy:    entry.data.CreatedBy,
			IsArchived:   entry.data.IsArchived,
			AllowedRoles: entry.data.AllowedRoles,
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"channels": channels,
		"count":    len(channels),
	})
}

// HandleGetChannel handles GET /api/v1/chat/channels/{id} — get channel details.
func (h *ChatHandler) HandleGetChannel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	channelID := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/channels/")
	if channelID == "" || strings.Contains(channelID, "/") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel ID is required"})
		return
	}

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	ctx := r.Context()

	// Read from anystore if available
	if h.store != nil {
		ch, err := h.store.GetChannel(ctx, channelID)
		if err == nil {
			userRole := h.getUserRole()
			if len(ch.AllowedRoles) > 0 && !containsRole(ch.AllowedRoles, userRole) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "access denied"})
				return
			}
			writeJSON(w, http.StatusOK, ChannelResponse{
				ID:           ch.ID,
				Name:         ch.Name,
				Description:  ch.Description,
				Icon:         ch.Icon,
				Photo:        ch.Photo,
				CreatedAt:    ch.CreatedAt,
				CreatedBy:    ch.CreatedBy,
				IsArchived:   ch.IsArchived,
				AllowedRoles: ch.AllowedRoles,
			})
			return
		}
	}

	// Fallback: tree scan
	objMgr := h.spaceManager.ObjectTreeManager()
	obj, err := objMgr.ReadLatestByID(ctx, communitySpaceID, channelID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("channel not found: %v", err),
		})
		return
	}

	var data ChatChannelData
	if err := json.Unmarshal(obj.Data, &data); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("invalid channel data: %v", err),
		})
		return
	}

	userRole := h.getUserRole()
	if len(data.AllowedRoles) > 0 && !containsRole(data.AllowedRoles, userRole) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "access denied"})
		return
	}

	writeJSON(w, http.StatusOK, ChannelResponse{
		ID:           obj.ID,
		Name:         data.Name,
		Description:  data.Description,
		Icon:         data.Icon,
		Photo:        data.Photo,
		CreatedAt:    data.CreatedAt,
		CreatedBy:    data.CreatedBy,
		IsArchived:   data.IsArchived,
		AllowedRoles: data.AllowedRoles,
	})
}

// HandleCreateChannel handles POST /api/v1/chat/channels — create a new channel.
func (h *ChatHandler) HandleCreateChannel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req CreateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	aid := ""
	if h.userIdentity != nil {
		aid = h.userIdentity.GetAID()
	}

	now := time.Now().UTC().Format(time.RFC3339)
	channelData := ChatChannelData{
		Name:         req.Name,
		Description:  req.Description,
		Icon:         req.Icon,
		Photo:        req.Photo,
		CreatedAt:    now,
		CreatedBy:    aid,
		AllowedRoles: req.AllowedRoles,
	}

	dataBytes, err := json.Marshal(channelData)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal channel data: %v", err),
		})
		return
	}

	// Get signing key for community space
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "any-sync client not available",
		})
		return
	}

	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), communitySpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	objectID := fmt.Sprintf("ChatChannel-%d", time.Now().UnixNano())
	ownerKey := ""
	if keys.SigningKey != nil {
		pubKeyBytes, _ := keys.SigningKey.GetPublic().Marshall()
		if pubKeyBytes != nil {
			ownerKey = fmt.Sprintf("%x", pubKeyBytes)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        objectID,
		Type:      "ChatChannel",
		OwnerKey:  ownerKey,
		Data:      dataBytes,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()

	headID, err := objMgr.AddObject(ctx, communitySpaceID, payload, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to create channel: %v", err),
		})
		return
	}

	// Broadcast channel creation event
	h.eventBroker.Broadcast(SSEEvent{
		Type: "chat:channel:new",
		Data: map[string]interface{}{
			"channelId": objectID,
			"name":      req.Name,
		},
	})

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"success":   true,
		"channelId": objectID,
		"headId":    headID,
	})
}

// HandleUpdateChannel handles PUT /api/v1/chat/channels/{id} — update a channel.
func (h *ChatHandler) HandleUpdateChannel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	channelID := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/channels/")
	if channelID == "" || strings.Contains(channelID, "/") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel ID is required"})
		return
	}

	var req UpdateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()

	// Read existing channel
	existing, err := objMgr.ReadLatestByID(ctx, communitySpaceID, channelID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("channel not found: %v", err),
		})
		return
	}

	var data ChatChannelData
	if err := json.Unmarshal(existing.Data, &data); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("invalid channel data: %v", err),
		})
		return
	}

	// Apply updates
	if req.Name != nil {
		data.Name = *req.Name
	}
	if req.Description != nil {
		data.Description = *req.Description
	}
	if req.Icon != nil {
		data.Icon = *req.Icon
	}
	if req.Photo != nil {
		data.Photo = *req.Photo
	}
	if req.AllowedRoles != nil {
		data.AllowedRoles = *req.AllowedRoles
	}

	dataBytes, err := json.Marshal(data)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal channel data: %v", err),
		})
		return
	}

	// Get signing key
	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), communitySpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	ownerKey := ""
	if keys.SigningKey != nil {
		pubKeyBytes, _ := keys.SigningKey.GetPublic().Marshall()
		if pubKeyBytes != nil {
			ownerKey = fmt.Sprintf("%x", pubKeyBytes)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        channelID,
		Type:      "ChatChannel",
		OwnerKey:  ownerKey,
		Data:      dataBytes,
		Timestamp: time.Now().Unix(),
		Version:   existing.Version + 1,
	}

	headID, err := objMgr.AddObject(ctx, communitySpaceID, payload, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to update channel: %v", err),
		})
		return
	}

	// Broadcast channel update event
	h.eventBroker.Broadcast(SSEEvent{
		Type: "chat:channel:update",
		Data: map[string]interface{}{
			"channelId": channelID,
			"name":      data.Name,
		},
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"channelId": channelID,
		"headId":    headID,
		"version":   existing.Version + 1,
	})
}

// HandleArchiveChannel handles DELETE /api/v1/chat/channels/{id} — archive a channel.
func (h *ChatHandler) HandleArchiveChannel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	channelID := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/channels/")
	if channelID == "" || strings.Contains(channelID, "/") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel ID is required"})
		return
	}

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()

	// Read existing channel
	existing, err := objMgr.ReadLatestByID(ctx, communitySpaceID, channelID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("channel not found: %v", err),
		})
		return
	}

	var data ChatChannelData
	if err := json.Unmarshal(existing.Data, &data); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("invalid channel data: %v", err),
		})
		return
	}

	// Set archived
	data.IsArchived = true

	dataBytes, err := json.Marshal(data)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal channel data: %v", err),
		})
		return
	}

	// Get signing key
	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), communitySpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	ownerKey := ""
	if keys.SigningKey != nil {
		pubKeyBytes, _ := keys.SigningKey.GetPublic().Marshall()
		if pubKeyBytes != nil {
			ownerKey = fmt.Sprintf("%x", pubKeyBytes)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        channelID,
		Type:      "ChatChannel",
		OwnerKey:  ownerKey,
		Data:      dataBytes,
		Timestamp: time.Now().Unix(),
		Version:   existing.Version + 1,
	}

	_, err = objMgr.AddObject(ctx, communitySpaceID, payload, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to archive channel: %v", err),
		})
		return
	}

	// Broadcast channel update event
	h.eventBroker.Broadcast(SSEEvent{
		Type: "chat:channel:update",
		Data: map[string]interface{}{
			"channelId":  channelID,
			"isArchived": true,
		},
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"channelId": channelID,
		"archived":  true,
	})
}

// --- Message Handlers ---

// HandleListMessages handles GET /api/v1/chat/channels/{id}/messages — list messages in a channel.
func (h *ChatHandler) HandleListMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	// Extract channel ID from path
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/channels/")
	parts := strings.Split(path, "/")
	if len(parts) < 2 || parts[1] != "messages" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
		return
	}
	channelID := parts[0]

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	// Parse pagination params
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	offset := 0
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		// cursor is "sentAt:messageID" — for anystore we use offset-based pagination
		// The frontend should switch to offset param, but for backwards compat we ignore cursor
		// and just return from offset 0. TODO: Add proper cursor→offset mapping.
	}

	ctx := r.Context()

	// Read from anystore if available
	if h.store != nil {
		msgs, err := h.store.ListMessagesByChannel(ctx, channelID, limit, offset)
		if err == nil {
			// Collect message IDs for reaction loading
			messageIDs := make([]string, len(msgs))
			for i, m := range msgs {
				messageIDs[i] = m.ID
			}

			// Load reactions from anystore
			reactionsMap, _ := h.store.ListReactionsByMessages(ctx, messageIDs)

			currentAID := ""
			if h.userIdentity != nil {
				currentAID = h.userIdentity.GetAID()
			}

			result := make([]MessageResponse, 0, len(msgs))
			for _, m := range msgs {
				rxns := reactionsMap[m.ID]
				aggregated := aggregateStoreReactions(rxns, currentAID)

				var attachments []AttachmentRef
				if len(m.Attachments) > 0 {
					json.Unmarshal(m.Attachments, &attachments)
				}

				result = append(result, MessageResponse{
					ID:          m.ID,
					ChannelID:   m.ChannelID,
					SenderAID:   m.SenderAID,
					SenderName:  m.SenderName,
					Content:     m.Content,
					Attachments: attachments,
					ReplyTo:     m.ReplyTo,
					SentAt:      m.SentAt,
					EditedAt:    m.EditedAt,
					DeletedAt:   m.DeletedAt,
					Reactions:   aggregated,
					Version:     m.Version,
				})
			}

			hasMore := len(msgs) == limit
			var nextCursor string
			if hasMore && len(msgs) > 0 {
				lastMsg := msgs[len(msgs)-1]
				nextCursor = fmt.Sprintf("%s:%s", lastMsg.SentAt, lastMsg.ID)
			}

			writeJSON(w, http.StatusOK, map[string]interface{}{
				"messages":   result,
				"count":      len(result),
				"nextCursor": nextCursor,
				"hasMore":    hasMore,
			})
			return
		}
	}

	// Fallback: tree scan
	h.handleListMessagesFallback(w, r, channelID, communitySpaceID, limit)
}

// HandleSendMessage handles POST /api/v1/chat/channels/{id}/messages — send a message.
func (h *ChatHandler) HandleSendMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	// Extract channel ID from path
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/channels/")
	parts := strings.Split(path, "/")
	if len(parts) < 2 || parts[1] != "messages" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
		return
	}
	channelID := parts[0]

	var req SendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.Content == "" && len(req.Attachments) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "content or attachments required",
		})
		return
	}

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	aid := ""
	senderName := "Anonymous"
	if h.userIdentity != nil {
		aid = h.userIdentity.GetAID()
		senderName = h.getSenderName(aid)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	messageData := ChatMessageData{
		ChannelID:   channelID,
		SenderAID:   aid,
		SenderName:  senderName,
		Content:     req.Content,
		Attachments: req.Attachments,
		ReplyTo:     req.ReplyTo,
		SentAt:      now,
	}

	dataBytes, err := json.Marshal(messageData)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal message data: %v", err),
		})
		return
	}

	// Get signing key for community space
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "any-sync client not available",
		})
		return
	}

	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), communitySpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	objectID := fmt.Sprintf("ChatMessage-%s-%d-%s", channelID, time.Now().UnixNano(), aid[:8])
	ownerKey := ""
	if keys.SigningKey != nil {
		pubKeyBytes, _ := keys.SigningKey.GetPublic().Marshall()
		if pubKeyBytes != nil {
			ownerKey = fmt.Sprintf("%x", pubKeyBytes)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        objectID,
		Type:      "ChatMessage",
		OwnerKey:  ownerKey,
		Data:      dataBytes,
		Timestamp: time.Now().Unix(),
		Version:   1,
	}

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()

	headID, err := objMgr.AddObject(ctx, communitySpaceID, payload, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to send message: %v", err),
		})
		return
	}

	// Broadcast message event
	h.eventBroker.Broadcast(SSEEvent{
		Type: "chat:message:new",
		Data: map[string]interface{}{
			"messageId":  objectID,
			"channelId":  channelID,
			"senderAid":  aid,
			"senderName": senderName,
			"content":    req.Content,
			"sentAt":     now,
		},
	})

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"success":   true,
		"messageId": objectID,
		"headId":    headID,
		"sentAt":    now,
	})
}

// HandleEditMessage handles PUT /api/v1/chat/messages/{id} — edit a message.
func (h *ChatHandler) HandleEditMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	messageID := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/messages/")
	if messageID == "" || strings.Contains(messageID, "/") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message ID is required"})
		return
	}

	var req EditMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.Content == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "content is required"})
		return
	}

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	ctx := r.Context()

	// Read existing message — prefer anystore, fall back to tree
	var senderAID, channelID string
	var existingVersion int
	var data ChatMessageData

	if h.store != nil {
		msg, err := h.store.GetMessage(ctx, messageID)
		if err == nil {
			senderAID = msg.SenderAID
			channelID = msg.ChannelID
			existingVersion = msg.Version
			data = ChatMessageData{
				ChannelID:   msg.ChannelID,
				SenderAID:   msg.SenderAID,
				SenderName:  msg.SenderName,
				Content:     msg.Content,
				ReplyTo:     msg.ReplyTo,
				SentAt:      msg.SentAt,
				EditedAt:    msg.EditedAt,
				DeletedAt:   msg.DeletedAt,
			}
			if len(msg.Attachments) > 0 {
				json.Unmarshal(msg.Attachments, &data.Attachments)
			}
		}
		// If err != nil, senderAID stays empty → falls through to tree scan
	}

	if senderAID == "" {
		// Fallback: tree scan
		objMgr := h.spaceManager.ObjectTreeManager()
		existing, err := objMgr.ReadLatestByID(ctx, communitySpaceID, messageID)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{
				"error": fmt.Sprintf("message not found: %v", err),
			})
			return
		}
		if err := json.Unmarshal(existing.Data, &data); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": fmt.Sprintf("invalid message data: %v", err),
			})
			return
		}
		senderAID = data.SenderAID
		channelID = data.ChannelID
		existingVersion = existing.Version
	}

	// Check ownership
	currentAID := ""
	if h.userIdentity != nil {
		currentAID = h.userIdentity.GetAID()
	}
	if senderAID != currentAID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "can only edit own messages"})
		return
	}

	// Update content
	data.Content = req.Content
	data.EditedAt = time.Now().UTC().Format(time.RFC3339)

	dataBytes, err := json.Marshal(data)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal message data: %v", err),
		})
		return
	}

	// Get signing key
	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), communitySpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	ownerKey := ""
	if keys.SigningKey != nil {
		pubKeyBytes, _ := keys.SigningKey.GetPublic().Marshall()
		if pubKeyBytes != nil {
			ownerKey = fmt.Sprintf("%x", pubKeyBytes)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        messageID,
		Type:      "ChatMessage",
		OwnerKey:  ownerKey,
		Data:      dataBytes,
		Timestamp: time.Now().Unix(),
		Version:   existingVersion + 1,
	}

	objMgr := h.spaceManager.ObjectTreeManager()
	headID, err := objMgr.AddObject(ctx, communitySpaceID, payload, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to edit message: %v", err),
		})
		return
	}

	// Broadcast message edit event
	h.eventBroker.Broadcast(SSEEvent{
		Type: "chat:message:edit",
		Data: map[string]interface{}{
			"messageId": messageID,
			"channelId": channelID,
			"content":   req.Content,
			"editedAt":  data.EditedAt,
		},
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"messageId": messageID,
		"headId":    headID,
		"version":   existingVersion + 1,
		"editedAt":  data.EditedAt,
	})
}

// HandleDeleteMessage handles DELETE /api/v1/chat/messages/{id} — soft delete a message.
func (h *ChatHandler) HandleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	messageID := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/messages/")
	if messageID == "" || strings.Contains(messageID, "/") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message ID is required"})
		return
	}

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	ctx := r.Context()

	// Read existing message — prefer anystore
	var data ChatMessageData
	var existingVersion int
	found := false

	if h.store != nil {
		msg, err := h.store.GetMessage(ctx, messageID)
		if err == nil {
			found = true
			existingVersion = msg.Version
			data = ChatMessageData{
				ChannelID:   msg.ChannelID,
				SenderAID:   msg.SenderAID,
				SenderName:  msg.SenderName,
				Content:     msg.Content,
				ReplyTo:     msg.ReplyTo,
				SentAt:      msg.SentAt,
				EditedAt:    msg.EditedAt,
				DeletedAt:   msg.DeletedAt,
			}
			if len(msg.Attachments) > 0 {
				json.Unmarshal(msg.Attachments, &data.Attachments)
			}
		}
	}

	if !found {
		// Fallback: tree scan
		objMgr := h.spaceManager.ObjectTreeManager()
		existing, err := objMgr.ReadLatestByID(ctx, communitySpaceID, messageID)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{
				"error": fmt.Sprintf("message not found: %v", err),
			})
			return
		}
		if err := json.Unmarshal(existing.Data, &data); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": fmt.Sprintf("invalid message data: %v", err),
			})
			return
		}
		existingVersion = existing.Version
	}

	// Check ownership
	currentAID := ""
	if h.userIdentity != nil {
		currentAID = h.userIdentity.GetAID()
	}
	if data.SenderAID != currentAID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "can only delete own messages"})
		return
	}

	// Soft delete
	data.DeletedAt = time.Now().UTC().Format(time.RFC3339)

	dataBytes, err := json.Marshal(data)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal message data: %v", err),
		})
		return
	}

	// Get signing key
	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), communitySpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	ownerKey := ""
	if keys.SigningKey != nil {
		pubKeyBytes, _ := keys.SigningKey.GetPublic().Marshall()
		if pubKeyBytes != nil {
			ownerKey = fmt.Sprintf("%x", pubKeyBytes)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        messageID,
		Type:      "ChatMessage",
		OwnerKey:  ownerKey,
		Data:      dataBytes,
		Timestamp: time.Now().Unix(),
		Version:   existingVersion + 1,
	}

	objMgr := h.spaceManager.ObjectTreeManager()
	_, err = objMgr.AddObject(ctx, communitySpaceID, payload, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to delete message: %v", err),
		})
		return
	}

	// Broadcast message delete event
	h.eventBroker.Broadcast(SSEEvent{
		Type: "chat:message:delete",
		Data: map[string]interface{}{
			"messageId": messageID,
			"channelId": data.ChannelID,
			"deletedAt": data.DeletedAt,
		},
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"messageId": messageID,
		"deleted":   true,
	})
}

// HandleGetThread handles GET /api/v1/chat/messages/{id}/thread — get thread replies.
func (h *ChatHandler) HandleGetThread(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	// Extract message ID from path
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/messages/")
	parts := strings.Split(path, "/")
	if len(parts) < 2 || parts[1] != "thread" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
		return
	}
	parentMessageID := parts[0]

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	ctx := r.Context()

	// Read from anystore if available
	if h.store != nil {
		replies, err := h.store.ListReplies(ctx, parentMessageID)
		if err == nil {
			messageIDs := make([]string, len(replies))
			for i, m := range replies {
				messageIDs[i] = m.ID
			}
			reactionsMap, _ := h.store.ListReactionsByMessages(ctx, messageIDs)

			currentAID := ""
			if h.userIdentity != nil {
				currentAID = h.userIdentity.GetAID()
			}

			result := make([]MessageResponse, 0, len(replies))
			for _, m := range replies {
				rxns := reactionsMap[m.ID]
				aggregated := aggregateStoreReactions(rxns, currentAID)

				var attachments []AttachmentRef
				if len(m.Attachments) > 0 {
					json.Unmarshal(m.Attachments, &attachments)
				}

				result = append(result, MessageResponse{
					ID:          m.ID,
					ChannelID:   m.ChannelID,
					SenderAID:   m.SenderAID,
					SenderName:  m.SenderName,
					Content:     m.Content,
					Attachments: attachments,
					ReplyTo:     m.ReplyTo,
					SentAt:      m.SentAt,
					EditedAt:    m.EditedAt,
					DeletedAt:   m.DeletedAt,
					Reactions:   aggregated,
					Version:     m.Version,
				})
			}

			writeJSON(w, http.StatusOK, map[string]interface{}{
				"replies":         result,
				"count":           len(result),
				"parentMessageId": parentMessageID,
			})
			return
		}
	}

	// Fallback: tree scan
	h.handleGetThreadFallback(w, r, parentMessageID, communitySpaceID)
}

// --- Reaction Handlers ---

// HandleAddReaction handles POST /api/v1/chat/messages/{id}/reactions — add a reaction.
func (h *ChatHandler) HandleAddReaction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	// Extract message ID from path
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/messages/")
	parts := strings.Split(path, "/")
	if len(parts) < 2 || parts[1] != "reactions" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
		return
	}
	messageID := parts[0]

	var req AddReactionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.Emoji == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "emoji is required"})
		return
	}

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	currentAID := ""
	if h.userIdentity != nil {
		currentAID = h.userIdentity.GetAID()
	}

	ctx := r.Context()

	reactionID := fmt.Sprintf("MessageReaction-%s-%s", messageID, req.Emoji)

	var reactionData MessageReactionData
	existingVersion := 0

	// Try anystore first, then tree fallback
	if h.store != nil {
		rxn, err := h.store.GetReaction(ctx, reactionID)
		if err == nil {
			reactionData = MessageReactionData{
				MessageID:   rxn.MessageID,
				Emoji:       rxn.Emoji,
				ReactorAIDs: rxn.ReactorAIDs,
			}
			existingVersion = rxn.Version

			for _, aid := range reactionData.ReactorAIDs {
				if aid == currentAID {
					writeJSON(w, http.StatusConflict, map[string]string{
						"error": "already reacted with this emoji",
					})
					return
				}
			}
			reactionData.ReactorAIDs = append(reactionData.ReactorAIDs, currentAID)
		} else {
			reactionData = MessageReactionData{
				MessageID:   messageID,
				Emoji:       req.Emoji,
				ReactorAIDs: []string{currentAID},
			}
		}
	} else {
		// Fallback: tree scan
		objMgr := h.spaceManager.ObjectTreeManager()
		existing, err := objMgr.ReadLatestByID(ctx, communitySpaceID, reactionID)
		if err == nil {
			if err := json.Unmarshal(existing.Data, &reactionData); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{
					"error": fmt.Sprintf("invalid reaction data: %v", err),
				})
				return
			}
			existingVersion = existing.Version

			for _, aid := range reactionData.ReactorAIDs {
				if aid == currentAID {
					writeJSON(w, http.StatusConflict, map[string]string{
						"error": "already reacted with this emoji",
					})
					return
				}
			}
			reactionData.ReactorAIDs = append(reactionData.ReactorAIDs, currentAID)
		} else {
			reactionData = MessageReactionData{
				MessageID:   messageID,
				Emoji:       req.Emoji,
				ReactorAIDs: []string{currentAID},
			}
		}
	}

	dataBytes, err := json.Marshal(reactionData)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal reaction data: %v", err),
		})
		return
	}

	// Get signing key
	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), communitySpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	ownerKey := ""
	if keys.SigningKey != nil {
		pubKeyBytes, _ := keys.SigningKey.GetPublic().Marshall()
		if pubKeyBytes != nil {
			ownerKey = fmt.Sprintf("%x", pubKeyBytes)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        reactionID,
		Type:      "MessageReaction",
		OwnerKey:  ownerKey,
		Data:      dataBytes,
		Timestamp: time.Now().Unix(),
		Version:   existingVersion + 1,
	}

	objMgr := h.spaceManager.ObjectTreeManager()
	_, err = objMgr.AddObject(ctx, communitySpaceID, payload, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to add reaction: %v", err),
		})
		return
	}

	// Broadcast reaction event
	h.eventBroker.Broadcast(SSEEvent{
		Type: "chat:reaction:add",
		Data: map[string]interface{}{
			"messageId":  messageID,
			"emoji":      req.Emoji,
			"reactorAid": currentAID,
			"count":      len(reactionData.ReactorAIDs),
		},
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"messageId": messageID,
		"emoji":     req.Emoji,
		"count":     len(reactionData.ReactorAIDs),
	})
}

// HandleRemoveReaction handles DELETE /api/v1/chat/messages/{id}/reactions/{emoji} — remove a reaction.
func (h *ChatHandler) HandleRemoveReaction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	// Extract message ID and emoji from path
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/messages/")
	parts := strings.Split(path, "/")
	if len(parts) < 3 || parts[1] != "reactions" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
		return
	}
	messageID := parts[0]
	emoji := parts[2]

	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "community space not configured",
		})
		return
	}

	currentAID := ""
	if h.userIdentity != nil {
		currentAID = h.userIdentity.GetAID()
	}

	ctx := r.Context()

	reactionID := fmt.Sprintf("MessageReaction-%s-%s", messageID, emoji)

	var reactionData MessageReactionData
	existingVersion := 0

	// Try anystore first
	if h.store != nil {
		rxn, err := h.store.GetReaction(ctx, reactionID)
		if err == nil {
			reactionData = MessageReactionData{
				MessageID:   rxn.MessageID,
				Emoji:       rxn.Emoji,
				ReactorAIDs: rxn.ReactorAIDs,
			}
			existingVersion = rxn.Version
		} else {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "reaction not found"})
			return
		}
	} else {
		// Fallback: tree scan
		objMgr := h.spaceManager.ObjectTreeManager()
		existing, err := objMgr.ReadLatestByID(ctx, communitySpaceID, reactionID)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "reaction not found"})
			return
		}
		if err := json.Unmarshal(existing.Data, &reactionData); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": fmt.Sprintf("invalid reaction data: %v", err),
			})
			return
		}
		existingVersion = existing.Version
	}

	// Remove user from reactors
	found := false
	newReactors := make([]string, 0, len(reactionData.ReactorAIDs))
	for _, aid := range reactionData.ReactorAIDs {
		if aid == currentAID {
			found = true
		} else {
			newReactors = append(newReactors, aid)
		}
	}

	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "you haven't reacted with this emoji",
		})
		return
	}

	reactionData.ReactorAIDs = newReactors

	dataBytes, err := json.Marshal(reactionData)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal reaction data: %v", err),
		})
		return
	}

	// Get signing key
	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), communitySpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	ownerKey := ""
	if keys.SigningKey != nil {
		pubKeyBytes, _ := keys.SigningKey.GetPublic().Marshall()
		if pubKeyBytes != nil {
			ownerKey = fmt.Sprintf("%x", pubKeyBytes)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        reactionID,
		Type:      "MessageReaction",
		OwnerKey:  ownerKey,
		Data:      dataBytes,
		Timestamp: time.Now().Unix(),
		Version:   existingVersion + 1,
	}

	objMgr := h.spaceManager.ObjectTreeManager()
	_, err = objMgr.AddObject(ctx, communitySpaceID, payload, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to remove reaction: %v", err),
		})
		return
	}

	// Broadcast reaction event
	h.eventBroker.Broadcast(SSEEvent{
		Type: "chat:reaction:remove",
		Data: map[string]interface{}{
			"messageId":  messageID,
			"emoji":      emoji,
			"reactorAid": currentAID,
			"count":      len(reactionData.ReactorAIDs),
		},
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"messageId": messageID,
		"emoji":     emoji,
		"count":     len(reactionData.ReactorAIDs),
	})
}

// --- Helper Functions ---

func (h *ChatHandler) getUserRole() string {
	// TODO: Look up the user's CommunityProfile to get their role
	// For now, return empty (treats as "member")
	return ""
}

func (h *ChatHandler) getSenderName(aid string) string {
	// TODO: Look up the user's SharedProfile to get their display name
	// For now, return a truncated AID
	if len(aid) > 12 {
		return aid[:12] + "..."
	}
	return aid
}

func containsRole(allowedRoles []string, userRole string) bool {
	for _, role := range allowedRoles {
		if strings.EqualFold(role, userRole) {
			return true
		}
	}
	return false
}

type messageEntry struct {
	obj  *anysync.ObjectPayload
	data ChatMessageData
}

func (h *ChatHandler) loadReactionsForMessages(
	ctx context.Context,
	objMgr *anysync.ObjectTreeManager,
	spaceID string,
	messages []*messageEntry,
) map[string][]MessageReactionData {
	result := make(map[string][]MessageReactionData)

	// Collect message IDs
	messageIDs := make(map[string]bool)
	for _, m := range messages {
		messageIDs[m.obj.ID] = true
	}

	// Read all reactions
	objects, err := objMgr.ReadObjectsByType(ctx, spaceID, "MessageReaction")
	if err != nil {
		return result
	}

	// Group by message ID, keeping latest version
	reactionMap := make(map[string]*anysync.ObjectPayload)
	for _, obj := range objects {
		if existing, ok := reactionMap[obj.ID]; !ok || obj.Version > existing.Version {
			reactionMap[obj.ID] = obj
		}
	}

	// Parse and group by message
	for _, obj := range reactionMap {
		var data MessageReactionData
		if err := json.Unmarshal(obj.Data, &data); err != nil {
			continue
		}
		if !messageIDs[data.MessageID] {
			continue
		}
		result[data.MessageID] = append(result[data.MessageID], data)
	}

	return result
}

func aggregateReactions(reactions []MessageReactionData, currentAID string) []ReactionAggregate {
	if len(reactions) == 0 {
		return nil
	}

	result := make([]ReactionAggregate, 0, len(reactions))
	for _, r := range reactions {
		hasReacted := false
		for _, aid := range r.ReactorAIDs {
			if aid == currentAID {
				hasReacted = true
				break
			}
		}

		result = append(result, ReactionAggregate{
			Emoji:       r.Emoji,
			Count:       len(r.ReactorAIDs),
			ReactorAIDs: r.ReactorAIDs,
			HasReacted:  hasReacted,
		})
	}

	return result
}

// aggregateStoreReactions converts anystore ChatReaction objects to ReactionAggregates.
func aggregateStoreReactions(reactions []*anystore.ChatReaction, currentAID string) []ReactionAggregate {
	if len(reactions) == 0 {
		return nil
	}

	result := make([]ReactionAggregate, 0, len(reactions))
	for _, r := range reactions {
		hasReacted := false
		for _, aid := range r.ReactorAIDs {
			if aid == currentAID {
				hasReacted = true
				break
			}
		}
		result = append(result, ReactionAggregate{
			Emoji:       r.Emoji,
			Count:       len(r.ReactorAIDs),
			ReactorAIDs: r.ReactorAIDs,
			HasReacted:  hasReacted,
		})
	}
	return result
}

// handleListMessagesFallback handles ListMessages via tree scan when anystore is unavailable.
func (h *ChatHandler) handleListMessagesFallback(w http.ResponseWriter, r *http.Request, channelID, communitySpaceID string, limit int) {
	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()

	objects, err := objMgr.ReadObjectsByType(ctx, communitySpaceID, "ChatMessage")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read messages: %v", err),
		})
		return
	}

	messageMap := make(map[string]*messageEntry)
	for _, obj := range objects {
		var data ChatMessageData
		if err := json.Unmarshal(obj.Data, &data); err != nil {
			continue
		}
		if data.ChannelID != channelID {
			continue
		}
		if existing, ok := messageMap[obj.ID]; !ok || obj.Version > existing.obj.Version {
			messageMap[obj.ID] = &messageEntry{obj: obj, data: data}
		}
	}

	messages := make([]*messageEntry, 0, len(messageMap))
	for _, entry := range messageMap {
		messages = append(messages, entry)
	}

	// Sort descending by sentAt
	for i := 0; i < len(messages); i++ {
		for j := i + 1; j < len(messages); j++ {
			if messages[i].data.SentAt < messages[j].data.SentAt {
				messages[i], messages[j] = messages[j], messages[i]
			}
		}
	}

	cursor := r.URL.Query().Get("cursor")
	startIdx := 0
	if cursor != "" {
		for i, m := range messages {
			cursorVal := fmt.Sprintf("%s:%s", m.data.SentAt, m.obj.ID)
			if cursorVal == cursor {
				startIdx = i + 1
				break
			}
		}
	}

	endIdx := startIdx + limit
	if endIdx > len(messages) {
		endIdx = len(messages)
	}

	reactions := h.loadReactionsForMessages(ctx, objMgr, communitySpaceID, messages[startIdx:endIdx])

	currentAID := ""
	if h.userIdentity != nil {
		currentAID = h.userIdentity.GetAID()
	}

	result := make([]MessageResponse, 0, endIdx-startIdx)
	for _, m := range messages[startIdx:endIdx] {
		msgReactions := reactions[m.obj.ID]
		aggregated := aggregateReactions(msgReactions, currentAID)

		result = append(result, MessageResponse{
			ID:          m.obj.ID,
			ChannelID:   m.data.ChannelID,
			SenderAID:   m.data.SenderAID,
			SenderName:  m.data.SenderName,
			Content:     m.data.Content,
			Attachments: m.data.Attachments,
			ReplyTo:     m.data.ReplyTo,
			SentAt:      m.data.SentAt,
			EditedAt:    m.data.EditedAt,
			DeletedAt:   m.data.DeletedAt,
			Reactions:   aggregated,
			Version:     m.obj.Version,
		})
	}

	var nextCursor string
	if endIdx < len(messages) {
		lastMsg := messages[endIdx-1]
		nextCursor = fmt.Sprintf("%s:%s", lastMsg.data.SentAt, lastMsg.obj.ID)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"messages":   result,
		"count":      len(result),
		"nextCursor": nextCursor,
		"hasMore":    endIdx < len(messages),
	})
}

// handleGetThreadFallback handles GetThread via tree scan when anystore is unavailable.
func (h *ChatHandler) handleGetThreadFallback(w http.ResponseWriter, r *http.Request, parentMessageID, communitySpaceID string) {
	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()

	objects, err := objMgr.ReadObjectsByType(ctx, communitySpaceID, "ChatMessage")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read messages: %v", err),
		})
		return
	}

	messageMap := make(map[string]*messageEntry)
	for _, obj := range objects {
		var data ChatMessageData
		if err := json.Unmarshal(obj.Data, &data); err != nil {
			continue
		}
		if data.ReplyTo != parentMessageID {
			continue
		}
		if existing, ok := messageMap[obj.ID]; !ok || obj.Version > existing.obj.Version {
			messageMap[obj.ID] = &messageEntry{obj: obj, data: data}
		}
	}

	replies := make([]*messageEntry, 0, len(messageMap))
	for _, entry := range messageMap {
		replies = append(replies, entry)
	}

	// Sort ascending by sentAt
	for i := 0; i < len(replies); i++ {
		for j := i + 1; j < len(replies); j++ {
			if replies[i].data.SentAt > replies[j].data.SentAt {
				replies[i], replies[j] = replies[j], replies[i]
			}
		}
	}

	reactions := h.loadReactionsForMessages(ctx, objMgr, communitySpaceID, replies)

	currentAID := ""
	if h.userIdentity != nil {
		currentAID = h.userIdentity.GetAID()
	}

	result := make([]MessageResponse, 0, len(replies))
	for _, m := range replies {
		msgReactions := reactions[m.obj.ID]
		aggregated := aggregateReactions(msgReactions, currentAID)

		result = append(result, MessageResponse{
			ID:          m.obj.ID,
			ChannelID:   m.data.ChannelID,
			SenderAID:   m.data.SenderAID,
			SenderName:  m.data.SenderName,
			Content:     m.data.Content,
			Attachments: m.data.Attachments,
			ReplyTo:     m.data.ReplyTo,
			SentAt:      m.data.SentAt,
			EditedAt:    m.data.EditedAt,
			DeletedAt:   m.data.DeletedAt,
			Reactions:   aggregated,
			Version:     m.obj.Version,
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"replies":         result,
		"count":           len(result),
		"parentMessageId": parentMessageID,
	})
}

// RegisterRoutes registers chat routes on the mux.
func (h *ChatHandler) RegisterRoutes(mux *http.ServeMux) {
	// Channel routes
	mux.HandleFunc("/api/v1/chat/channels", CORSHandler(h.handleChannels))
	mux.HandleFunc("/api/v1/chat/channels/", CORSHandler(h.handleChannelByID))

	// Message routes
	mux.HandleFunc("/api/v1/chat/messages/", CORSHandler(h.handleMessages))
}

// handleChannels routes /api/v1/chat/channels requests.
func (h *ChatHandler) handleChannels(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.HandleListChannels(w, r)
	case http.MethodPost:
		h.HandleCreateChannel(w, r)
	case http.MethodOptions:
		w.WriteHeader(http.StatusOK)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

// handleChannelByID routes /api/v1/chat/channels/{id} and nested routes.
func (h *ChatHandler) handleChannelByID(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/channels/")
	parts := strings.Split(path, "/")

	if len(parts) == 1 {
		// /api/v1/chat/channels/{id}
		switch r.Method {
		case http.MethodGet:
			h.HandleGetChannel(w, r)
		case http.MethodPut:
			h.HandleUpdateChannel(w, r)
		case http.MethodDelete:
			h.HandleArchiveChannel(w, r)
		case http.MethodOptions:
			w.WriteHeader(http.StatusOK)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
		return
	}

	if len(parts) >= 2 && parts[1] == "messages" {
		// /api/v1/chat/channels/{id}/messages
		switch r.Method {
		case http.MethodGet:
			h.HandleListMessages(w, r)
		case http.MethodPost:
			h.HandleSendMessage(w, r)
		case http.MethodOptions:
			w.WriteHeader(http.StatusOK)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
		return
	}

	writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
}

// handleMessages routes /api/v1/chat/messages/{id} and nested routes.
func (h *ChatHandler) handleMessages(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/chat/messages/")
	parts := strings.Split(path, "/")

	if len(parts) == 1 {
		// /api/v1/chat/messages/{id}
		switch r.Method {
		case http.MethodPut:
			h.HandleEditMessage(w, r)
		case http.MethodDelete:
			h.HandleDeleteMessage(w, r)
		case http.MethodOptions:
			w.WriteHeader(http.StatusOK)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
		return
	}

	if len(parts) >= 2 {
		switch parts[1] {
		case "thread":
			// /api/v1/chat/messages/{id}/thread
			if r.Method == http.MethodGet || r.Method == http.MethodOptions {
				if r.Method == http.MethodOptions {
					w.WriteHeader(http.StatusOK)
					return
				}
				h.HandleGetThread(w, r)
				return
			}
		case "reactions":
			// /api/v1/chat/messages/{id}/reactions
			if len(parts) == 2 {
				switch r.Method {
				case http.MethodPost:
					h.HandleAddReaction(w, r)
				case http.MethodOptions:
					w.WriteHeader(http.StatusOK)
				default:
					writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				}
				return
			}
			// /api/v1/chat/messages/{id}/reactions/{emoji}
			if len(parts) == 3 {
				switch r.Method {
				case http.MethodDelete:
					h.HandleRemoveReaction(w, r)
				case http.MethodOptions:
					w.WriteHeader(http.StatusOK)
				default:
					writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				}
				return
			}
		}
	}

	writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
}
