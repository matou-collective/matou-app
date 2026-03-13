package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
)

// DecisionPlansHandler handles decision plan and governance action HTTP requests.
type DecisionPlansHandler struct {
	service      *contributions.Service
	spaceManager *anysync.SpaceManager
}

// NewDecisionPlansHandler creates a new decision plans handler.
func NewDecisionPlansHandler(service *contributions.Service, spaceManager *anysync.SpaceManager) *DecisionPlansHandler {
	return &DecisionPlansHandler{service: service, spaceManager: spaceManager}
}

// RegisterRoutes registers decision plan and governance action routes on the mux.
func (h *DecisionPlansHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/decision-plans", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.HandleList(w, r)
		case http.MethodPost:
			h.HandleCreate(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))

	mux.HandleFunc("/api/v1/decision-plans/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/decision-plans/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "decision plan id required"})
			return
		}

		if len(parts) == 2 && parts[1] == "transition" && r.Method == http.MethodPost {
			h.HandleTransition(w, r, id)
			return
		}
		if len(parts) == 2 && parts[1] == "actions" {
			switch r.Method {
			case http.MethodPost:
				h.HandleAddAction(w, r, id)
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

	mux.HandleFunc("/api/v1/governance-actions/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/governance-actions/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "governance action id required"})
			return
		}

		if len(parts) == 2 && parts[1] == "complete" && r.Method == http.MethodPost {
			h.HandleCompleteAction(w, r, id)
			return
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}))
}

// HandleCreate handles POST /api/v1/decision-plans
func (h *DecisionPlansHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var req contributions.CreateDecisionPlanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	dp, err := h.service.CreateDecisionPlan(r.Context(), spaceID, &req)
	if err != nil {
		log.Printf("[DecisionPlans] create failed: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[DecisionPlans] decision plan created: %s for proposal %s", dp.ID, dp.ProposalID)
	writeJSON(w, http.StatusCreated, dp)
}

// HandleGet handles GET /api/v1/decision-plans/{id}
func (h *DecisionPlansHandler) HandleGet(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	dp, err := h.service.GetDecisionPlan(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, http.StatusOK, dp)
}

// HandleList handles GET /api/v1/decision-plans
func (h *DecisionPlansHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	plans, err := h.service.ListDecisionPlans(r.Context(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"decision_plans": plans, "total": len(plans)})
}

// HandleTransition handles POST /api/v1/decision-plans/{id}/transition
func (h *DecisionPlansHandler) HandleTransition(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	dp, err := h.service.TransitionDecisionPlan(r.Context(), spaceID, id, contributions.DecisionPlanStatus(req.Status))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, dp)
}

// HandleAddAction handles POST /api/v1/decision-plans/{id}/actions
func (h *DecisionPlansHandler) HandleAddAction(w http.ResponseWriter, r *http.Request, dpID string) {
	var req contributions.CreateGovernanceActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	req.DecisionPlanID = dpID
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	action, err := h.service.AddGovernanceAction(r.Context(), spaceID, &req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, action)
}

// HandleCompleteAction handles POST /api/v1/governance-actions/{id}/complete
func (h *DecisionPlansHandler) HandleCompleteAction(w http.ResponseWriter, r *http.Request, actionID string) {
	var req struct {
		Outcome string `json:"outcome"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	action, err := h.service.CompleteGovernanceAction(r.Context(), spaceID, actionID, contributions.OutcomeType(req.Outcome))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, action)
}
