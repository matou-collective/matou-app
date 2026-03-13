package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
)

// ContribNotifier is a narrow interface used by ContributionsHandler to send
// in-app notifications without importing the notifications package directly
// (which would create an import cycle via notifications/adapters.go).
type ContribNotifier interface {
	Notify(n *ContribNotification) error
}

// ContribNotification is a slim notification type used within the api package
// to avoid importing the full notifications package.
type ContribNotification struct {
	Type        string
	RecipientID string
	Title       string
	Message     string
	EntityID    string
	EntityType  string
}

// ContributionsHandler handles contribution and registration HTTP requests.
type ContributionsHandler struct {
	service      *contributions.Service
	spaceManager *anysync.SpaceManager
	notifier     ContribNotifier
}

// NewContributionsHandler creates a new contributions handler.
// notifier may be nil — notifications are skipped gracefully when not configured.
func NewContributionsHandler(service *contributions.Service, spaceManager *anysync.SpaceManager, notifier ContribNotifier) *ContributionsHandler {
	return &ContributionsHandler{
		service:      service,
		spaceManager: spaceManager,
		notifier:     notifier,
	}
}

// RegisterRoutes registers contribution routes on the mux.
func (h *ContributionsHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/contributions", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.HandleList(w, r)
		case http.MethodPost:
			h.HandleCreate(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))

	mux.HandleFunc("/api/v1/contributions/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/contributions/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
			return
		}

		if len(parts) == 2 {
			switch parts[1] {
			case "transition":
				if r.Method == http.MethodPost {
					h.HandleTransition(w, r, id)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "register":
				if r.Method == http.MethodPost {
					h.HandleRegister(w, r, id)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "registrations":
				if r.Method == http.MethodGet {
					h.HandleListRegistrations(w, r, id)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "assign":
				if r.Method == http.MethodPost {
					h.HandleAssign(w, r, id)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			}
		}

		switch r.Method {
		case http.MethodGet:
			h.HandleGet(w, r, id)
		case http.MethodPut:
			h.HandleUpdate(w, r, id)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))
}

// HandleCreate handles POST /api/v1/contributions
func (h *ContributionsHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var req contributions.CreateContributionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.CreateContribution(r.Context(), spaceID, &req)
	if err != nil {
		log.Printf("[Contributions] failed to create contribution: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution created: %s in project %s", contrib.ID, contrib.ProjectID)
	writeJSON(w, http.StatusCreated, contrib)
}

// HandleList handles GET /api/v1/contributions
func (h *ContributionsHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contribs, err := h.service.ListContributions(r.Context(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"contributions": contribs, "total": len(contribs)})
}

// HandleGet handles GET /api/v1/contributions/{id}
func (h *ContributionsHandler) HandleGet(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.GetContribution(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "contribution not found"})
		return
	}
	writeJSON(w, http.StatusOK, contrib)
}

// HandleTransition handles POST /api/v1/contributions/{id}/transition
func (h *ContributionsHandler) HandleTransition(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.TransitionContribution(r.Context(), spaceID, id, contributions.ContributionStatus(req.Status))
	if err != nil {
		log.Printf("[Contributions] transition failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution %s transitioned to %s", id, req.Status)
	writeJSON(w, http.StatusOK, contrib)
}

// HandleUpdate handles PUT /api/v1/contributions/{id}
func (h *ContributionsHandler) HandleUpdate(w http.ResponseWriter, r *http.Request, id string) {
	var req map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.GetContribution(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "contribution not found"})
		return
	}
	// Apply updates from request
	if v, ok := req["evidence_submitted"]; ok {
		if evidence, ok := v.([]interface{}); ok {
			contrib.EvidenceSubmitted = make([]string, len(evidence))
			for i, e := range evidence {
				contrib.EvidenceSubmitted[i], _ = e.(string)
			}
		}
	}
	if v, ok := req["completion_notes"].(string); ok {
		contrib.CompletionNotes = v
	}
	if v, ok := req["review_feedback"].(string); ok {
		contrib.ReviewFeedback = v
	}
	if v, ok := req["quality_rating"].(float64); ok {
		contrib.QualityRating = int(v)
	}
	if err := h.service.SaveContribution(r.Context(), spaceID, contrib); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution updated: %s", id)
	writeJSON(w, http.StatusOK, contrib)
}

// HandleRegister handles POST /api/v1/contributions/{id}/register
// Registers a contributor's interest in a contribution and notifies relevant parties.
func (h *ContributionsHandler) HandleRegister(w http.ResponseWriter, r *http.Request, contribID string) {
	var req struct {
		UserID    string `json:"user_id"`
		Statement string `json:"statement"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_id is required"})
		return
	}

	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	// Get the contribution to find project lead for notification
	contrib, err := h.service.GetContribution(r.Context(), spaceID, contribID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "contribution not found"})
		return
	}

	reg, err := h.service.RegisterInterest(r.Context(), spaceID, contribID, req.UserID, req.Statement)
	if err != nil {
		log.Printf("[Contributions] RegisterInterest failed for %s by %s: %v", contribID, req.UserID, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	log.Printf("[Contributions] %s registered interest in contribution %s", req.UserID, contribID)

	// Notify project lead if a notifier is configured
	if h.notifier != nil && contrib.CreatedBy != "" {
		h.notifier.Notify(&ContribNotification{
			Type:        "contribution:registered",
			RecipientID: contrib.CreatedBy,
			Title:       "New Registration",
			Message:     req.UserID + " registered interest in " + contrib.Title,
			EntityID:    contribID,
			EntityType:  "contribution",
		})
	}

	writeJSON(w, http.StatusCreated, reg)
}

// HandleListRegistrations handles GET /api/v1/contributions/{id}/registrations
func (h *ContributionsHandler) HandleListRegistrations(w http.ResponseWriter, r *http.Request, contribID string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	regs, err := h.service.ListRegistrations(r.Context(), spaceID, contribID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"registrations": regs, "total": len(regs)})
}

// HandleAssign handles POST /api/v1/contributions/{id}/assign
func (h *ContributionsHandler) HandleAssign(w http.ResponseWriter, r *http.Request, contribID string) {
	var req struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_id is required"})
		return
	}

	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.AssignContributor(r.Context(), spaceID, contribID, req.UserID)
	if err != nil {
		log.Printf("[Contributions] AssignContributor failed for %s: %v", contribID, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	log.Printf("[Contributions] contribution %s assigned to %s", contribID, req.UserID)

	// Notify the assigned contributor
	if h.notifier != nil {
		h.notifier.Notify(&ContribNotification{
			Type:        "contribution:assigned",
			RecipientID: req.UserID,
			Title:       "Contribution Assigned",
			Message:     "You have been assigned to: " + contrib.Title,
			EntityID:    contribID,
			EntityType:  "contribution",
		})
	}

	writeJSON(w, http.StatusOK, contrib)
}

// setupTestContributionsHandler creates a handler with mock store for testing.
func setupTestContributionsHandler() *ContributionsHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewContributionsHandler(svc, nil, nil)
}
