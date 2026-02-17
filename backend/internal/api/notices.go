package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/types"
)

// NoticesHandler handles community notice board HTTP requests.
type NoticesHandler struct {
	spaceManager *anysync.SpaceManager
	userIdentity *identity.UserIdentity
	eventBroker  *EventBroker
}

// NewNoticesHandler creates a new notices handler.
func NewNoticesHandler(
	spaceManager *anysync.SpaceManager,
	userIdentity *identity.UserIdentity,
	eventBroker *EventBroker,
) *NoticesHandler {
	return &NoticesHandler{
		spaceManager: spaceManager,
		userIdentity: userIdentity,
		eventBroker:  eventBroker,
	}
}

// RegisterRoutes registers notice routes on the mux.
func (h *NoticesHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/notices", h.handleNotices)
	mux.HandleFunc("/api/v1/notices/saved", h.HandleListSaved)
	mux.HandleFunc("/api/v1/notices/", h.handleNoticeByID)
}

// handleNotices routes /api/v1/notices requests.
func (h *NoticesHandler) handleNotices(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.HandleListNotices(w, r)
	case http.MethodPost:
		h.HandleCreateNotice(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

// handleNoticeByID routes /api/v1/notices/{id}/... requests.
func (h *NoticesHandler) handleNoticeByID(w http.ResponseWriter, r *http.Request) {
	// Parse: /api/v1/notices/{id} or /api/v1/notices/{id}/{action}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/notices/")
	if path == "" || path == "saved" {
		return // handled by other routes
	}

	parts := strings.SplitN(path, "/", 2)
	noticeID := parts[0]

	if len(parts) == 1 {
		// GET /api/v1/notices/{id}
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		h.HandleGetNotice(w, r, noticeID)
		return
	}

	action := parts[1]
	switch action {
	case "publish":
		h.HandlePublishNotice(w, r, noticeID)
	case "archive":
		h.HandleArchiveNotice(w, r, noticeID)
	case "rsvp":
		switch r.Method {
		case http.MethodPost:
			h.HandleCreateRSVP(w, r, noticeID)
		case http.MethodGet:
			h.HandleListRSVPs(w, r, noticeID)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	case "ack":
		switch r.Method {
		case http.MethodPost:
			h.HandleCreateAck(w, r, noticeID)
		case http.MethodGet:
			h.HandleListAcks(w, r, noticeID)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	case "save":
		h.HandleToggleSave(w, r, noticeID)
	case "comments":
		switch r.Method {
		case http.MethodPost:
			h.HandleCreateComment(w, r, noticeID)
		case http.MethodGet:
			h.HandleListComments(w, r, noticeID)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	case "reactions":
		switch r.Method {
		case http.MethodPost:
			h.HandleToggleReaction(w, r, noticeID)
		case http.MethodGet:
			h.HandleListReactions(w, r, noticeID)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	case "pin":
		h.HandleTogglePin(w, r, noticeID)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown action"})
	}
}

// CreateNoticeRequest represents a request to create a notice.
type CreateNoticeRequest struct {
	ID           string          `json:"id,omitempty"`
	Type         string          `json:"type"`     // "event", "update", or "announcement"
	Title        string          `json:"title"`
	Summary      string          `json:"summary"`
	Body         string          `json:"body,omitempty"`
	Links        json.RawMessage `json:"links,omitempty"`
	Images       json.RawMessage `json:"images,omitempty"`
	Attachments  json.RawMessage `json:"attachments,omitempty"`
	State        string          `json:"state,omitempty"` // "draft" or "published", defaults to "draft"
	Subtype      string          `json:"subtype,omitempty"`
	EventStart   string          `json:"eventStart,omitempty"`
	EventEnd     string          `json:"eventEnd,omitempty"`
	Timezone     string          `json:"timezone,omitempty"`
	LocationMode string          `json:"locationMode,omitempty"`
	LocationText string          `json:"locationText,omitempty"`
	LocationURL  string          `json:"locationUrl,omitempty"`
	RSVPEnabled  bool            `json:"rsvpEnabled,omitempty"`
	RSVPRequired bool            `json:"rsvpRequired,omitempty"`
	RSVPCapacity int             `json:"rsvpCapacity,omitempty"`
	AckRequired  bool            `json:"ackRequired,omitempty"`
	AckDueAt     string          `json:"ackDueAt,omitempty"`
	ActiveFrom   string          `json:"activeFrom,omitempty"`
	ActiveUntil  string          `json:"activeUntil,omitempty"`
}

// HandleCreateNotice handles POST /api/v1/notices.
func (h *NoticesHandler) HandleCreateNotice(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req CreateNoticeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	// Validate required fields
	if req.Type == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type is required"})
		return
	}
	if req.Type != "event" && req.Type != "update" && req.Type != "announcement" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type must be 'event', 'update', or 'announcement'"})
		return
	}
	if req.Title == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "title is required"})
		return
	}
	if req.Summary == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "summary is required"})
		return
	}

	// Default state
	if req.State == "" {
		req.State = "draft"
	}
	if req.State != "draft" && req.State != "published" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "state must be 'draft' or 'published'"})
		return
	}

	// Get user identity
	aid := ""
	if h.userIdentity != nil {
		aid = h.userIdentity.GetAID()
	}
	if aid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "identity not configured"})
		return
	}

	// Get community space
	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "community space not configured"})
		return
	}

	// Get signing key
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "any-sync client not available"})
		return
	}

	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	// Generate notice ID
	noticeID := req.ID
	if noticeID == "" {
		noticeID = fmt.Sprintf("%d", time.Now().UnixMilli())
	}

	now := time.Now().UTC().Format(time.RFC3339)
	notice := &anysync.NoticePayload{
		ID:           noticeID,
		Type:         req.Type,
		Subtype:      req.Subtype,
		Title:        req.Title,
		Summary:      req.Summary,
		Body:         req.Body,
		Links:        req.Links,
		Images:       req.Images,
		Attachments:  req.Attachments,
		IssuerType:   "person",
		IssuerID:     aid,
		AudienceMode: "community",
		State:        req.State,
		CreatedAt:    now,
		CreatedBy:    aid,
		EventStart:   req.EventStart,
		EventEnd:     req.EventEnd,
		Timezone:     req.Timezone,
		LocationMode: req.LocationMode,
		LocationText: req.LocationText,
		LocationURL:  req.LocationURL,
		RSVPEnabled:  req.RSVPEnabled,
		RSVPRequired: req.RSVPRequired,
		RSVPCapacity: req.RSVPCapacity,
		AckRequired:  req.AckRequired,
		AckDueAt:     req.AckDueAt,
		ActiveFrom:   req.ActiveFrom,
		ActiveUntil:  req.ActiveUntil,
	}

	if req.State == "published" {
		notice.PublishedAt = now
		notice.PublishAt = now
	}

	noticeMgr := h.spaceManager.NoticeTreeManager()
	treeID, err := noticeMgr.CreateNotice(r.Context(), spaceID, notice, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to create notice: %v", err),
		})
		return
	}

	// Broadcast SSE event
	if h.eventBroker != nil {
		h.eventBroker.Broadcast(SSEEvent{
			Type: "notice_created",
			Data: map[string]interface{}{
				"noticeId": noticeID,
				"type":     req.Type,
				"state":    req.State,
				"title":    req.Title,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"noticeId": noticeID,
		"treeId":   treeID,
		"state":    req.State,
		"spaceId":  spaceID,
	})
}

// HandleListNotices handles GET /api/v1/notices.
// Supports query params: ?view=upcoming|current|past&type=event|update
func (h *NoticesHandler) HandleListNotices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var spaceID string
	if h.spaceManager != nil {
		spaceID = h.spaceManager.GetCommunitySpaceID()
	}
	if spaceID == "" {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"notices": []interface{}{},
			"count":   0,
		})
		return
	}

	noticeMgr := h.spaceManager.NoticeTreeManager()
	notices, err := noticeMgr.ReadNotices(r.Context(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read notices: %v", err),
		})
		return
	}

	// Apply filters
	view := r.URL.Query().Get("view")
	typeFilter := r.URL.Query().Get("type")
	now := time.Now().UTC()

	var filtered []*anysync.NoticePayload
	for _, n := range notices {
		// Type filter
		if typeFilter != "" && n.Type != typeFilter {
			continue
		}

		// View filter
		switch view {
		case "upcoming":
			if n.Type != "event" || n.State != "published" {
				continue
			}
			if n.EventStart != "" {
				if t, err := time.Parse(time.RFC3339, n.EventStart); err == nil && t.Before(now) {
					continue
				}
			}
		case "current":
			if (n.Type != "update" && n.Type != "announcement") || n.State != "published" {
				continue
			}
			if n.ActiveUntil != "" {
				if t, err := time.Parse(time.RFC3339, n.ActiveUntil); err == nil && t.Before(now) {
					continue
				}
			}
		case "past":
			isPast := n.State == "archived"
			if !isPast && n.ActiveUntil != "" {
				if t, err := time.Parse(time.RFC3339, n.ActiveUntil); err == nil && t.Before(now) {
					isPast = true
				}
			}
			if !isPast {
				continue
			}
		}

		filtered = append(filtered, n)
	}

	// Sort by view
	sortNotices(filtered, view)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"notices": filtered,
		"count":   len(filtered),
		"view":    view,
	})
}

// HandleGetNotice handles GET /api/v1/notices/{id}.
func (h *NoticesHandler) HandleGetNotice(w http.ResponseWriter, r *http.Request, noticeID string) {
	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "community space not configured"})
		return
	}

	noticeMgr := h.spaceManager.NoticeTreeManager()
	notice, err := noticeMgr.ReadNotice(r.Context(), spaceID, noticeID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("notice not found: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, notice)
}

// HandlePublishNotice handles POST /api/v1/notices/{id}/publish.
func (h *NoticesHandler) HandlePublishNotice(w http.ResponseWriter, r *http.Request, noticeID string) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	h.transitionNotice(w, r, noticeID, "published")
}

// HandleArchiveNotice handles POST /api/v1/notices/{id}/archive.
func (h *NoticesHandler) HandleArchiveNotice(w http.ResponseWriter, r *http.Request, noticeID string) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	h.transitionNotice(w, r, noticeID, "archived")
}

// transitionNotice handles lifecycle state transitions for a notice.
func (h *NoticesHandler) transitionNotice(w http.ResponseWriter, r *http.Request, noticeID, targetState string) {
	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "community space not configured"})
		return
	}

	// Read current notice to validate transition
	noticeMgr := h.spaceManager.NoticeTreeManager()
	notice, err := noticeMgr.ReadNotice(r.Context(), spaceID, noticeID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("notice not found: %v", err),
		})
		return
	}

	if !types.IsValidNoticeTransition(notice.State, targetState) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid transition: %s -> %s", notice.State, targetState),
		})
		return
	}

	// Get signing key
	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	if err := noticeMgr.UpdateNoticeState(r.Context(), spaceID, noticeID, targetState, keys.SigningKey); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to transition notice: %v", err),
		})
		return
	}

	// Broadcast SSE event
	if h.eventBroker != nil {
		h.eventBroker.Broadcast(SSEEvent{
			Type: "notice_" + targetState,
			Data: map[string]interface{}{
				"noticeId": noticeID,
				"state":    targetState,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"noticeId": noticeID,
		"state":    targetState,
	})
}

// RSVPRequest represents a request to RSVP to a notice.
type RSVPRequest struct {
	Status string `json:"status"` // "going", "maybe", "not_going"
}

// HandleCreateRSVP handles POST /api/v1/notices/{id}/rsvp.
func (h *NoticesHandler) HandleCreateRSVP(w http.ResponseWriter, r *http.Request, noticeID string) {
	var req RSVPRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.Status != "going" && req.Status != "maybe" && req.Status != "not_going" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "status must be 'going', 'maybe', or 'not_going'",
		})
		return
	}

	aid := ""
	if h.userIdentity != nil {
		aid = h.userIdentity.GetAID()
	}
	if aid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "identity not configured"})
		return
	}

	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "community space not configured"})
		return
	}

	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	rsvp := &anysync.NoticeRSVPPayload{
		NoticeID:  noticeID,
		UserID:    aid,
		Status:    req.Status,
		UpdatedAt: now,
	}

	noticeMgr := h.spaceManager.NoticeTreeManager()
	treeID, err := noticeMgr.CreateRSVP(r.Context(), spaceID, rsvp, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to create RSVP: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"noticeId": noticeID,
		"status":   req.Status,
		"treeId":   treeID,
	})
}

// HandleListRSVPs handles GET /api/v1/notices/{id}/rsvp.
func (h *NoticesHandler) HandleListRSVPs(w http.ResponseWriter, r *http.Request, noticeID string) {
	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"rsvps": []interface{}{},
			"count": 0,
		})
		return
	}

	noticeMgr := h.spaceManager.NoticeTreeManager()
	rsvps, err := noticeMgr.ReadRSVPs(r.Context(), spaceID, noticeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read RSVPs: %v", err),
		})
		return
	}

	// Compute counts
	counts := map[string]int{"going": 0, "maybe": 0, "not_going": 0}
	for _, rsvp := range rsvps {
		counts[rsvp.Status]++
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"rsvps":  rsvps,
		"count":  len(rsvps),
		"counts": counts,
	})
}

// HandleCreateAck handles POST /api/v1/notices/{id}/ack.
func (h *NoticesHandler) HandleCreateAck(w http.ResponseWriter, r *http.Request, noticeID string) {
	aid := ""
	if h.userIdentity != nil {
		aid = h.userIdentity.GetAID()
	}
	if aid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "identity not configured"})
		return
	}

	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "community space not configured"})
		return
	}

	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	ack := &anysync.NoticeAckPayload{
		NoticeID: noticeID,
		UserID:   aid,
		AckAt:    now,
		Method:   "explicit",
	}

	noticeMgr := h.spaceManager.NoticeTreeManager()
	treeID, err := noticeMgr.CreateAck(r.Context(), spaceID, ack, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to create ack: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"noticeId": noticeID,
		"treeId":   treeID,
	})
}

// HandleListAcks handles GET /api/v1/notices/{id}/ack.
func (h *NoticesHandler) HandleListAcks(w http.ResponseWriter, r *http.Request, noticeID string) {
	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"acks":  []interface{}{},
			"count": 0,
		})
		return
	}

	noticeMgr := h.spaceManager.NoticeTreeManager()
	acks, err := noticeMgr.ReadAcks(r.Context(), spaceID, noticeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read acks: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"acks":  acks,
		"count": len(acks),
	})
}

// HandleToggleSave handles POST /api/v1/notices/{id}/save.
func (h *NoticesHandler) HandleToggleSave(w http.ResponseWriter, r *http.Request, noticeID string) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	aid := ""
	if h.userIdentity != nil {
		aid = h.userIdentity.GetAID()
	}
	if aid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "identity not configured"})
		return
	}

	// Saves go to personal space
	privateSpaceID := ""
	if h.userIdentity != nil {
		privateSpaceID = h.userIdentity.GetPrivateSpaceID()
	}
	if privateSpaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "private space not configured"})
		return
	}

	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), privateSpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	save := &anysync.NoticeSavePayload{
		NoticeID: noticeID,
		UserID:   aid,
		SavedAt:  now,
		Pinned:   true,
	}

	// Check if already saved — toggle off
	noticeMgr := h.spaceManager.NoticeTreeManager()
	existingSaves, _ := noticeMgr.ReadSaves(r.Context(), privateSpaceID)
	for _, s := range existingSaves {
		if s.NoticeID == noticeID {
			// Toggle: if pinned, unpin
			save.Pinned = !s.Pinned
			break
		}
	}

	treeID, err := noticeMgr.CreateSave(r.Context(), privateSpaceID, save, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to toggle save: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"noticeId": noticeID,
		"pinned":   save.Pinned,
		"treeId":   treeID,
	})
}

// HandleListSaved handles GET /api/v1/notices/saved.
func (h *NoticesHandler) HandleListSaved(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var privateSpaceID string
	if h.userIdentity != nil {
		privateSpaceID = h.userIdentity.GetPrivateSpaceID()
	}
	if privateSpaceID == "" || h.spaceManager == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"saves": []interface{}{},
			"count": 0,
		})
		return
	}

	noticeMgr := h.spaceManager.NoticeTreeManager()
	saves, err := noticeMgr.ReadSaves(r.Context(), privateSpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read saves: %v", err),
		})
		return
	}

	// Filter to only pinned saves
	var pinned []*anysync.NoticeSavePayload
	for _, s := range saves {
		if s.Pinned {
			pinned = append(pinned, s)
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"saves": pinned,
		"count": len(pinned),
	})
}

// CommentRequest represents a request to create a comment.
type CommentRequest struct {
	Text string `json:"text"`
}

// HandleCreateComment handles POST /api/v1/notices/{id}/comments.
func (h *NoticesHandler) HandleCreateComment(w http.ResponseWriter, r *http.Request, noticeID string) {
	var req CommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if req.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text is required"})
		return
	}
	if len(req.Text) > 2000 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text must be 2000 characters or less"})
		return
	}

	aid := ""
	if h.userIdentity != nil {
		aid = h.userIdentity.GetAID()
	}
	if aid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "identity not configured"})
		return
	}

	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "community space not configured"})
		return
	}

	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	commentID := fmt.Sprintf("%d", time.Now().UnixMilli())
	comment := &anysync.NoticeCommentPayload{
		ID:        commentID,
		NoticeID:  noticeID,
		UserID:    aid,
		Text:      req.Text,
		CreatedAt: now,
	}

	noticeMgr := h.spaceManager.NoticeTreeManager()
	treeID, err := noticeMgr.CreateComment(r.Context(), spaceID, comment, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to create comment: %v", err),
		})
		return
	}

	if h.eventBroker != nil {
		h.eventBroker.Broadcast(SSEEvent{
			Type: "notice_comment",
			Data: map[string]interface{}{
				"noticeId":  noticeID,
				"commentId": commentID,
				"userId":    aid,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"noticeId":  noticeID,
		"commentId": commentID,
		"treeId":    treeID,
	})
}

// HandleListComments handles GET /api/v1/notices/{id}/comments.
func (h *NoticesHandler) HandleListComments(w http.ResponseWriter, r *http.Request, noticeID string) {
	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"comments": []interface{}{},
			"count":    0,
		})
		return
	}

	noticeMgr := h.spaceManager.NoticeTreeManager()
	comments, err := noticeMgr.ReadComments(r.Context(), spaceID, noticeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read comments: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"comments": comments,
		"count":    len(comments),
	})
}

// ReactionRequest represents a request to toggle a reaction.
type ReactionRequest struct {
	Emoji string `json:"emoji"`
}

// HandleToggleReaction handles POST /api/v1/notices/{id}/reactions.
func (h *NoticesHandler) HandleToggleReaction(w http.ResponseWriter, r *http.Request, noticeID string) {
	var req ReactionRequest
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
	if !types.IsValidEmoji(req.Emoji) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid emoji"})
		return
	}

	aid := ""
	if h.userIdentity != nil {
		aid = h.userIdentity.GetAID()
	}
	if aid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "identity not configured"})
		return
	}

	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "community space not configured"})
		return
	}

	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	reaction := &anysync.NoticeReactionPayload{
		NoticeID:  noticeID,
		UserID:    aid,
		Emoji:     req.Emoji,
		Active:    true,
		CreatedAt: now,
	}

	// Check existing reactions for toggle behavior
	noticeMgr := h.spaceManager.NoticeTreeManager()
	existingReactions, _ := noticeMgr.ReadReactions(r.Context(), spaceID, noticeID)
	for _, existing := range existingReactions {
		if existing.UserID == aid && existing.Emoji == req.Emoji {
			reaction.Active = !existing.Active
			break
		}
	}

	treeID, err := noticeMgr.CreateReaction(r.Context(), spaceID, reaction, keys.SigningKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to toggle reaction: %v", err),
		})
		return
	}

	if h.eventBroker != nil {
		h.eventBroker.Broadcast(SSEEvent{
			Type: "notice_reaction",
			Data: map[string]interface{}{
				"noticeId": noticeID,
				"userId":   aid,
				"emoji":    req.Emoji,
				"active":   reaction.Active,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"noticeId": noticeID,
		"emoji":    req.Emoji,
		"active":   reaction.Active,
		"treeId":   treeID,
	})
}

// HandleListReactions handles GET /api/v1/notices/{id}/reactions.
func (h *NoticesHandler) HandleListReactions(w http.ResponseWriter, r *http.Request, noticeID string) {
	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"reactions": []interface{}{},
			"counts":    map[string]int{},
		})
		return
	}

	noticeMgr := h.spaceManager.NoticeTreeManager()
	allReactions, err := noticeMgr.ReadReactions(r.Context(), spaceID, noticeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read reactions: %v", err),
		})
		return
	}

	// Filter to active only and compute counts
	var active []*anysync.NoticeReactionPayload
	counts := map[string]int{}
	for _, r := range allReactions {
		if r.Active {
			active = append(active, r)
			counts[r.Emoji]++
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"reactions": active,
		"counts":    counts,
	})
}

// HandleTogglePin handles POST /api/v1/notices/{id}/pin.
func (h *NoticesHandler) HandleTogglePin(w http.ResponseWriter, r *http.Request, noticeID string) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	spaceID := h.spaceManager.GetCommunitySpaceID()
	if spaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "community space not configured"})
		return
	}

	// Read current notice to determine toggle direction
	noticeMgr := h.spaceManager.NoticeTreeManager()
	notice, err := noticeMgr.ReadNotice(r.Context(), spaceID, noticeID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("notice not found: %v", err),
		})
		return
	}

	newPinned := !notice.Pinned

	client := h.spaceManager.GetClient()
	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	if err := noticeMgr.UpdateNoticePinned(r.Context(), spaceID, noticeID, newPinned, keys.SigningKey); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to toggle pin: %v", err),
		})
		return
	}

	if h.eventBroker != nil {
		h.eventBroker.Broadcast(SSEEvent{
			Type: "notice_published",
			Data: map[string]interface{}{
				"noticeId": noticeID,
				"pinned":   newPinned,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"noticeId": noticeID,
		"pinned":   newPinned,
	})
}

// sortNotices sorts notices based on the board view.
func sortNotices(notices []*anysync.NoticePayload, view string) {
	if len(notices) <= 1 {
		return
	}

	// Simple insertion sort (sufficient for v1 scale)
	for i := 1; i < len(notices); i++ {
		for j := i; j > 0; j-- {
			if shouldSwap(notices[j-1], notices[j], view) {
				notices[j-1], notices[j] = notices[j], notices[j-1]
			}
		}
	}
}

// shouldSwap returns true if a should come after b in the sort order.
func shouldSwap(a, b *anysync.NoticePayload, view string) bool {
	switch view {
	case "upcoming":
		// Sort by eventStart ascending
		return a.EventStart > b.EventStart
	case "current":
		// Sort by publishAt descending (most recent first)
		return a.PublishAt < b.PublishAt
	case "past":
		// Sort by publishAt descending
		return a.PublishAt < b.PublishAt
	default:
		// Default: most recently created first
		return a.CreatedAt < b.CreatedAt
	}
}

func init() {
	// Ensure the handler compiles with expected interface
	log.SetFlags(log.LstdFlags | log.Lshortfile)
}
