package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
)

// ImplementationPlansHandler handles implementation plan HTTP requests.
type ImplementationPlansHandler struct {
	service      *contributions.Service
	spaceManager *anysync.SpaceManager
}

// NewImplementationPlansHandler creates a new implementation plans handler.
func NewImplementationPlansHandler(service *contributions.Service, spaceManager *anysync.SpaceManager) *ImplementationPlansHandler {
	return &ImplementationPlansHandler{
		service:      service,
		spaceManager: spaceManager,
	}
}

// RegisterRoutes registers implementation plan routes on the mux.
func (h *ImplementationPlansHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/implementation-plans", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.HandleList(w, r)
		case http.MethodPost:
			h.HandleCreate(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))

	mux.HandleFunc("/api/v1/implementation-plans/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/implementation-plans/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "implementation plan id required"})
			return
		}

		if len(parts) == 2 && parts[1] == "milestones" && r.Method == http.MethodPost {
			h.HandleAddMilestone(w, r, id)
			return
		}
		if r.Method == http.MethodGet {
			h.HandleGet(w, r, id)
			return
		}
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}))
}

// HandleCreate handles POST /api/v1/implementation-plans
func (h *ImplementationPlansHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var req contributions.CreateImplementationPlanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	plan, err := h.service.CreateImplementationPlan(r.Context(), spaceID, &req)
	if err != nil {
		log.Printf("[ImplementationPlans] failed to create plan: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[ImplementationPlans] plan created: %s", plan.ID)
	writeJSON(w, http.StatusCreated, plan)
}

// HandleList handles GET /api/v1/implementation-plans
func (h *ImplementationPlansHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	plans, err := h.service.ListImplementationPlans(r.Context(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"implementation_plans": plans, "total": len(plans)})
}

// HandleGet handles GET /api/v1/implementation-plans/{id}
func (h *ImplementationPlansHandler) HandleGet(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	plan, err := h.service.GetImplementationPlan(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "implementation plan not found"})
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

// HandleAddMilestone handles POST /api/v1/implementation-plans/{id}/milestones
func (h *ImplementationPlansHandler) HandleAddMilestone(w http.ResponseWriter, r *http.Request, id string) {
	var req contributions.CreateMilestoneRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	req.ImplementationPlanID = id
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	milestone, err := h.service.AddMilestone(r.Context(), spaceID, &req)
	if err != nil {
		log.Printf("[ImplementationPlans] failed to add milestone to plan %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, milestone)
}

// setupTestImplementationPlansHandler creates a handler with mock store for testing.
func setupTestImplementationPlansHandler() *ImplementationPlansHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewImplementationPlansHandler(svc, nil)
}
