package api

import (
	"encoding/json"
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
}

// NewProposalsHandler creates a new proposals handler.
func NewProposalsHandler(service *contributions.Service, spaceManager *anysync.SpaceManager) *ProposalsHandler {
	return &ProposalsHandler{
		service:      service,
		spaceManager: spaceManager,
	}
}

// RegisterRoutes registers proposal routes on the mux.
// ProposalsHandler uses RBACMiddleware on the collection endpoint.
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
	mux.HandleFunc("/api/v1/proposals/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
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
		if r.Method == http.MethodGet {
			h.HandleGet(w, r, id)
			return
		}
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}))
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
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	proposal, err := h.service.TransitionProposal(r.Context(), spaceID, id, contributions.ProposalStatus(req.Status))
	if err != nil {
		log.Printf("[Proposals] transition failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
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

	if err := h.service.AddEndorsement(r.Context(), spaceID, id, &endorsement); err != nil {
		log.Printf("[Proposals] failed to add endorsement for proposal %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	log.Printf("[Proposals] endorsement added for proposal %s by %s", id, endorsement.EndorserID)
	writeJSON(w, http.StatusCreated, map[string]string{"success": "true"})
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
