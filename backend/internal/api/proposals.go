package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
)

// ProposalsHandler handles proposal-related HTTP requests.
type ProposalsHandler struct {
	service      *contributions.Service
	spaceManager *anysync.SpaceManager
	broker       *EventBroker
}

// NewProposalsHandler creates a new proposals handler.
func NewProposalsHandler(service *contributions.Service, spaceManager *anysync.SpaceManager) *ProposalsHandler {
	return &ProposalsHandler{
		service:      service,
		spaceManager: spaceManager,
	}
}

// SetBroker sets the event broker for SSE broadcasting.
func (h *ProposalsHandler) SetBroker(broker *EventBroker) {
	h.broker = broker
}

// RegisterRoutes registers proposal routes on the mux.
// Both the collection and sub-resource endpoints use RBAC middleware for role resolution.
func (h *ProposalsHandler) RegisterRoutes(mux *http.ServeMux, roleLookup RoleLookup) {
	mux.HandleFunc("/api/v1/proposals", CORSHandler(RBACMiddleware(roleLookup, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.HandleList(w, r)
		case http.MethodPost:
			h.HandleCreate(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})))

	// Pattern: /api/v1/proposals/{id}[/sub-resource]
	// OptionalRBACMiddleware populates roles in context when X-User-AID is present
	// but does not reject unauthenticated requests (e.g. GET).
	mux.HandleFunc("/api/v1/proposals/", CORSHandler(OptionalRBACMiddleware(roleLookup, func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/proposals/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "proposal id required"})
			return
		}

		if len(parts) == 2 && parts[1] == "transition" && r.Method == http.MethodPost {
			h.HandleTransition(w, r, id)
			return
		}
		if len(parts) == 2 && parts[1] == "endorsements" {
			switch r.Method {
			case http.MethodGet:
				h.HandleListEndorsements(w, r, id)
			case http.MethodPost:
				h.HandleAddEndorsement(w, r, id)
			default:
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			}
			return
		}
		if len(parts) == 2 && parts[1] == "history" && r.Method == http.MethodGet {
			h.HandleListHistory(w, r, id)
			return
		}
		if len(parts) == 2 && parts[1] == "comments" {
			switch r.Method {
			case http.MethodGet:
				h.HandleListComments(w, r, id)
			case http.MethodPost:
				h.HandleAddComment(w, r, id)
			default:
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			}
			return
		}
		if r.Method == http.MethodPatch {
			h.HandleUpdate(w, r, id)
			return
		}
		if r.Method == http.MethodGet {
			h.HandleGet(w, r, id)
			return
		}
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	})))
}

// isRoleClaimOnly returns true if the update request only sets role assignment
// fields (proposal_lead_id and/or proposal_steward_id) and no content fields.
func isRoleClaimOnly(req *contributions.UpdateProposalRequest) bool {
	hasRoleField := req.ProposalLeadID != nil || req.ProposalStewardID != nil
	hasContentField := req.Title != nil || req.Description != nil ||
		req.ProblemStatement != nil || req.Solution != nil ||
		req.ExpectedOutcomes != nil || req.EstimatedBudget != nil ||
		req.Timeline != nil || req.Attachments != nil
	return hasRoleField && !hasContentField
}

// HandleCreate handles POST /api/v1/proposals
func (h *ProposalsHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var req contributions.CreateProposalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("[Proposals] failed to decode request: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	proposal, err := h.service.CreateProposal(r.Context(), spaceID, &req)
	if err != nil {
		log.Printf("[Proposals] failed to create proposal: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	log.Printf("[Proposals] proposal created: %s by %s", proposal.ID, proposal.ProposerID)
	writeJSON(w, http.StatusCreated, proposal)
}

// HandleList handles GET /api/v1/proposals
func (h *ProposalsHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	proposals, err := h.service.ListProposals(r.Context(), spaceID)
	if err != nil {
		log.Printf("[Proposals] failed to list proposals: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"proposals": proposals,
		"total":     len(proposals),
	})
}

// HandleGet handles GET /api/v1/proposals/{id}
func (h *ProposalsHandler) HandleGet(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	proposal, err := h.service.GetProposal(r.Context(), spaceID, id)
	if err != nil {
		log.Printf("[Proposals] proposal not found: %s: %v", id, err)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "proposal not found"})
		return
	}

	writeJSON(w, http.StatusOK, proposal)
}

// HandleTransition handles POST /api/v1/proposals/{id}/transition
func (h *ProposalsHandler) HandleTransition(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Status string `json:"status"`
		Reason string `json:"reason,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Sign-off and rejection require admin (steward/founding) role
	targetStatus := contributions.ProposalStatus(req.Status)
	var requiredAction contributions.Action
	switch targetStatus {
	case contributions.ProposalSignedOff:
		requiredAction = contributions.ActionSignOffProposal
	case contributions.ProposalRejected:
		requiredAction = contributions.ActionRejectProposal
	}
	if requiredAction != "" {
		aid := r.Header.Get("X-User-AID")
		if aid == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "X-User-AID header required"})
			return
		}
		roles := GetUserRoles(r)
		if !contributions.CanPerformAction(roles, requiredAction) {
			log.Printf("[Proposals] %s denied for proposal %s: aid=%s roles=%v", req.Status, id, aid, roles)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions: admin role required"})
			return
		}
	}

	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	proposal, err := h.service.TransitionProposal(r.Context(), spaceID, id, contributions.ProposalStatus(req.Status))
	if err != nil {
		log.Printf("[Proposals] transition failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	// Record history
	action := fmt.Sprintf("Transitioned to %s", req.Status)
	if req.Reason != "" {
		action = fmt.Sprintf("Transitioned to %s - %s", req.Status, req.Reason)
	}
	h.service.AddHistoryEntry(r.Context(), spaceID, &contributions.ProposalHistoryEntry{
		ProposalID: id,
		UserID:     r.Header.Get("X-User-AID"),
		Action:     action,
	})

	// Broadcast SSE event
	if h.broker != nil {
		h.broker.Broadcast(SSEEvent{
			Type: "proposal:status_changed",
			Data: map[string]string{
				"proposal_id": id,
				"status":      req.Status,
			},
		})
	}

	log.Printf("[Proposals] proposal %s transitioned to %s", id, req.Status)
	writeJSON(w, http.StatusOK, proposal)
}

// HandleAddEndorsement handles POST /api/v1/proposals/{id}/endorsements
func (h *ProposalsHandler) HandleAddEndorsement(w http.ResponseWriter, r *http.Request, id string) {
	var endorsement contributions.Endorsement
	if err := json.NewDecoder(r.Body).Decode(&endorsement); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	result, err := h.service.AddEndorsement(r.Context(), spaceID, id, &endorsement)
	if err != nil {
		log.Printf("[Proposals] failed to add endorsement for proposal %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	// Broadcast SSE event
	if h.broker != nil {
		h.broker.Broadcast(SSEEvent{
			Type: "proposal:endorsed",
			Data: map[string]interface{}{
				"proposal_id":   id,
				"endorser_id":   endorsement.EndorserID,
				"threshold_met": result.ThresholdMet,
			},
		})
	}

	log.Printf("[Proposals] endorsement added for proposal %s by %s (threshold_met=%v)", id, endorsement.EndorserID, result.ThresholdMet)
	writeJSON(w, http.StatusCreated, result)
}

// HandleListEndorsements handles GET /api/v1/proposals/{id}/endorsements
func (h *ProposalsHandler) HandleListEndorsements(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	endorsements, err := h.service.GetEndorsements(r.Context(), spaceID, id)
	if err != nil {
		log.Printf("[Proposals] failed to list endorsements: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"endorsements": endorsements,
		"total":        len(endorsements),
	})
}

// HandleUpdate handles PATCH /api/v1/proposals/{id}
func (h *ProposalsHandler) HandleUpdate(w http.ResponseWriter, r *http.Request, id string) {
	var req contributions.UpdateProposalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	// For in_review proposals, only the proposer or an admin can edit content.
	// Role claims (proposal_lead_id, proposal_steward_id) are allowed for any authenticated user.
	existing, err := h.service.GetProposal(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "proposal not found"})
		return
	}
	if existing.Status == contributions.ProposalInReview && !isRoleClaimOnly(&req) {
		aid := r.Header.Get("X-User-AID")
		if aid == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "X-User-AID header required"})
			return
		}
		userName := r.Header.Get("X-User-Name")
		isProposer := aid == existing.ProposerID || (userName != "" && userName == existing.ProposerID)

		roles := GetUserRoles(r)
		isAdmin := contributions.CanPerformAction(roles, contributions.ActionEditProposal)

		if !isProposer && !isAdmin {
			log.Printf("[Proposals] edit denied for proposal %s: aid=%s userName=%s roles=%v", id, aid, userName, roles)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions: admin role or proposer identity required"})
			return
		}
	}

	proposal, err := h.service.UpdateProposal(r.Context(), spaceID, id, &req)
	if err != nil {
		log.Printf("[Proposals] update failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Proposals] proposal %s updated", id)
	writeJSON(w, http.StatusOK, proposal)
}

// HandleListHistory handles GET /api/v1/proposals/{id}/history
func (h *ProposalsHandler) HandleListHistory(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	entries, err := h.service.ListHistory(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"history": entries,
		"total":   len(entries),
	})
}

// HandleAddComment handles POST /api/v1/proposals/{id}/comments
func (h *ProposalsHandler) HandleAddComment(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	var req struct {
		UserID   string `json:"user_id"`
		UserName string `json:"user_name"`
		Text     string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if req.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text is required"})
		return
	}
	comment := &contributions.ProposalComment{
		ProposalID: id,
		UserID:     req.UserID,
		UserName:   req.UserName,
		Text:       req.Text,
	}
	created, err := h.service.AddProposalComment(r.Context(), spaceID, comment)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// HandleListComments handles GET /api/v1/proposals/{id}/comments
func (h *ProposalsHandler) HandleListComments(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	comments, err := h.service.ListProposalComments(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"comments": comments,
		"total":    len(comments),
	})
}

// setupTestProposalsHandler creates a handler with mock store for testing.
// Uses a nil SpaceManager — handler methods that need space IDs will use
// X-Space-ID header in tests or fall back to "community".
func setupTestProposalsHandler() *ProposalsHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewProposalsHandler(svc, nil)
}

// resolveCommunitySpaceID resolves the community space ID.
// Shared utility used by all contribution handlers.
// In production: uses SpaceManager. In tests: uses X-Space-ID header fallback.
func resolveCommunitySpaceID(r *http.Request, sm *anysync.SpaceManager) string {
	if override := r.Header.Get("X-Space-ID"); override != "" {
		return override // test override
	}
	if sm != nil {
		return sm.GetCommunitySpaceID()
	}
	return "community" // fallback for unit tests with nil SpaceManager
}
