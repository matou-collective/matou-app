package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
)

// MilestonesHandler handles milestone HTTP requests.
type MilestonesHandler struct {
	service      *contributions.Service
	spaceManager *anysync.SpaceManager
}

// NewMilestonesHandler creates a new milestones handler.
func NewMilestonesHandler(service *contributions.Service, spaceManager *anysync.SpaceManager) *MilestonesHandler {
	return &MilestonesHandler{
		service:      service,
		spaceManager: spaceManager,
	}
}

// RegisterRoutes registers milestone routes on the mux.
// roleLookup is used to apply RBAC to mutating endpoints; pass nil to skip auth (tests only).
func (h *MilestonesHandler) RegisterRoutes(mux *http.ServeMux, roleLookup RoleLookup) {
	mux.HandleFunc("/api/v1/milestones/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/milestones/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "milestone id required"})
			return
		}

		if len(parts) == 2 {
			switch parts[1] {
			case "archive":
				if r.Method == http.MethodPost {
					if roleLookup != nil {
						RBACMiddleware(roleLookup, RequireAction(contributions.ActionArchiveMilestone, func(w http.ResponseWriter, r *http.Request) {
							h.HandleArchiveMilestone(w, r, id)
						}))(w, r)
					} else {
						h.HandleArchiveMilestone(w, r, id)
					}
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			}
		}

		switch r.Method {
		case http.MethodPut:
			if roleLookup != nil {
				RBACMiddleware(roleLookup, RequireAction(contributions.ActionEditMilestone, func(w http.ResponseWriter, r *http.Request) {
					h.HandleUpdateMilestone(w, r, id)
				}))(w, r)
			} else {
				h.HandleUpdateMilestone(w, r, id)
			}
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))
}

// HandleArchiveMilestone handles POST /api/v1/milestones/{id}/archive
func (h *MilestonesHandler) HandleArchiveMilestone(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	if err := h.service.ArchiveMilestone(r.Context(), spaceID, id); err != nil {
		log.Printf("[Milestones] archive failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Milestones] milestone archived: %s", id)
	writeJSON(w, http.StatusOK, map[string]string{"success": "true"})
}

// HandleUpdateMilestone handles PUT /api/v1/milestones/{id}
func (h *MilestonesHandler) HandleUpdateMilestone(w http.ResponseWriter, r *http.Request, id string) {
	var req contributions.UpdateMilestoneRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	ms, err := h.service.UpdateMilestone(r.Context(), spaceID, id, &req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Milestones] milestone updated: %s", id)
	writeJSON(w, http.StatusOK, ms)
}

// setupTestMilestonesHandler creates a handler with mock store for testing.
func setupTestMilestonesHandler() *MilestonesHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewMilestonesHandler(svc, nil)
}
