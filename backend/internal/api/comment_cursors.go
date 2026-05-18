package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/identity"
)

// CommentCursorsData stores per-entity comment read cursors for one user.
// Keys are of the form "<entity_type>:<entity_id>" (e.g. "project:proj_...",
// "contribution:contrib_...", "notice:notice_..."). Values are the comment
// count at the time of last read.
type CommentCursorsData struct {
	Cursors map[string]int `json:"cursors"`
}

// UpdateCommentCursorRequest is the request body for PUT /api/v1/comment-cursors.
type UpdateCommentCursorRequest struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}

// CommentCursorsHandler handles per-user comment read cursor persistence.
// Cursors live in the user's private space as a single versioned object,
// mirroring the chat read-cursor pattern.
type CommentCursorsHandler struct {
	spaceManager *anysync.SpaceManager
	userIdentity *identity.UserIdentity
}

func NewCommentCursorsHandler(spaceManager *anysync.SpaceManager, userIdentity *identity.UserIdentity) *CommentCursorsHandler {
	return &CommentCursorsHandler{
		spaceManager: spaceManager,
		userIdentity: userIdentity,
	}
}

func (h *CommentCursorsHandler) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/comment-cursors", CORSHandler(h.route))
}

func (h *CommentCursorsHandler) route(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.handleGet(w, r)
	case http.MethodPut:
		h.handlePut(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
	}
}

func (h *CommentCursorsHandler) handleGet(w http.ResponseWriter, r *http.Request) {
	privateSpaceID := h.userIdentity.GetPrivateSpaceID()
	userAID := h.userIdentity.GetAID()
	if privateSpaceID == "" || userAID == "" {
		writeJSON(w, http.StatusOK, map[string]interface{}{"cursors": map[string]int{}})
		return
	}

	ctx := r.Context()
	h.spaceManager.TreeManager().BuildSpaceIndex(ctx, privateSpaceID)

	objMgr := h.spaceManager.ObjectTreeManager()
	objectID := "comment-cursors-" + userAID

	obj, err := objMgr.ReadLatestByID(ctx, privateSpaceID, objectID)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"cursors": map[string]int{}})
		return
	}

	var data CommentCursorsData
	if err := json.Unmarshal(obj.Data, &data); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("invalid comment cursors data: %v", err),
		})
		return
	}
	if data.Cursors == nil {
		data.Cursors = map[string]int{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"cursors": data.Cursors})
}

func (h *CommentCursorsHandler) handlePut(w http.ResponseWriter, r *http.Request) {
	var req UpdateCommentCursorRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}
	if req.Key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key is required"})
		return
	}
	if req.Count < 0 {
		req.Count = 0
	}

	privateSpaceID := h.userIdentity.GetPrivateSpaceID()
	userAID := h.userIdentity.GetAID()
	if privateSpaceID == "" || userAID == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "user identity not configured",
		})
		return
	}

	ctx := r.Context()
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "any-sync client not available",
		})
		return
	}

	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), privateSpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	objectID := "comment-cursors-" + userAID
	objMgr := h.spaceManager.ObjectTreeManager()

	var data CommentCursorsData
	existingVersion := 0
	existing, err := objMgr.ReadLatestByID(ctx, privateSpaceID, objectID)
	if err == nil {
		if err := json.Unmarshal(existing.Data, &data); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": fmt.Sprintf("invalid comment cursors data: %v", err),
			})
			return
		}
		existingVersion = existing.Version
		if data.Cursors == nil {
			data.Cursors = map[string]int{}
		}
	} else {
		data = CommentCursorsData{Cursors: map[string]int{}}
	}
	// Don't let cursor go backwards
	if prev := data.Cursors[req.Key]; req.Count < prev {
		req.Count = prev
	}
	data.Cursors[req.Key] = req.Count

	dataBytes, err := json.Marshal(data)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal comment cursors: %v", err),
		})
		return
	}

	ownerKey := ""
	if keys.SigningKey != nil {
		if pubKeyBytes, _ := keys.SigningKey.GetPublic().Marshall(); pubKeyBytes != nil {
			ownerKey = fmt.Sprintf("%x", pubKeyBytes)
		}
	}

	payload := &anysync.ObjectPayload{
		ID:        objectID,
		Type:      "CommentCursors",
		OwnerKey:  ownerKey,
		Data:      dataBytes,
		Timestamp: time.Now().Unix(),
		Version:   existingVersion + 1,
	}

	if _, err := objMgr.AddObject(ctx, privateSpaceID, payload, keys.SigningKey); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to update comment cursor: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"cursors": data.Cursors,
	})
}
