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
	requireRoleLookup("MilestonesHandler", roleLookup)
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
					projectRBAC(roleLookup, contributions.ActionArchiveMilestone, h.service, h.spaceManager, h.milestoneProjectID(id), func(w http.ResponseWriter, r *http.Request) {
						h.HandleArchiveMilestone(w, r, id)
					})(w, r)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			}
		}

		switch r.Method {
		case http.MethodPut:
			projectRBAC(roleLookup, contributions.ActionEditMilestone, h.service, h.spaceManager, h.milestoneProjectID(id), func(w http.ResponseWriter, r *http.Request) {
				h.HandleUpdateMilestone(w, r, id)
			})(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))
}

// milestoneProjectID resolves the project a milestone belongs to for
// project-scoped RBAC: the milestone's own project_id when set, otherwise via
// its implementation plan.
func (h *MilestonesHandler) milestoneProjectID(milestoneID string) ProjectIDResolver {
	return func(r *http.Request, spaceID string) (string, error) {
		ms, err := h.service.GetMilestone(r.Context(), spaceID, milestoneID)
		if err != nil {
			return "", err
		}
		if ms.ProjectID != "" {
			return ms.ProjectID, nil
		}
		if ms.ImplementationPlanID == "" {
			return "", nil
		}
		plan, err := h.service.GetImplementationPlan(r.Context(), spaceID, ms.ImplementationPlanID)
		if err != nil {
			return "", err
		}
		return plan.ProjectID, nil
	}
}

// HandleArchiveMilestone handles POST /api/v1/milestones/{id}/archive
func (h *MilestonesHandler) HandleArchiveMilestone(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	actorID := GetUserAID(r)
	if actorID == "" {
		actorID = r.Header.Get("X-User-AID")
	}
	if err := h.service.ArchiveMilestone(r.Context(), spaceID, id, actorID); err != nil {
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
	actorID := GetUserAID(r)
	if actorID == "" {
		actorID = r.Header.Get("X-User-AID")
	}
	ms, err := h.service.UpdateMilestone(r.Context(), spaceID, id, actorID, &req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Milestones] milestone updated: %s", id)
	writeJSON(w, http.StatusOK, ms)
}
