package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
)

// ProjectsHandler handles project-related HTTP requests.
type ProjectsHandler struct {
	service      *contributions.Service
	spaceManager *anysync.SpaceManager
	notifier     ContribNotifier
}

// NewProjectsHandler creates a new projects handler.
// notifier may be nil — notifications are skipped gracefully when not configured.
func NewProjectsHandler(service *contributions.Service, spaceManager *anysync.SpaceManager, notifier ContribNotifier) *ProjectsHandler {
	return &ProjectsHandler{
		service:      service,
		spaceManager: spaceManager,
		notifier:     notifier,
	}
}

// RegisterRoutes registers project routes on the mux.
// roleLookup is used to apply RBAC to mutating endpoints; pass nil to skip auth (tests only).
func (h *ProjectsHandler) RegisterRoutes(mux *http.ServeMux, roleLookup RoleLookup) {
	createHandler := http.HandlerFunc(h.HandleCreate)
	if roleLookup != nil {
		createHandler = RBACMiddleware(roleLookup, RequireAction(contributions.ActionCreateProject, h.HandleCreate))
	}

	mux.HandleFunc("/api/v1/projects", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.HandleList(w, r)
		case http.MethodPost:
			createHandler(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))

	mux.HandleFunc("/api/v1/projects/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/projects/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "project id required"})
			return
		}

		if len(parts) == 2 {
			switch parts[1] {
			case "link-proposal":
				if r.Method == http.MethodPost {
					h.HandleLinkProposal(w, r, id)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "contributions":
				if r.Method == http.MethodGet {
					h.HandleListProjectContributions(w, r, id)
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
			if roleLookup != nil {
				RBACMiddleware(roleLookup, RequireAction(contributions.ActionEditProject, func(w http.ResponseWriter, r *http.Request) {
					h.HandleUpdate(w, r, id)
				}))(w, r)
			} else {
				h.HandleUpdate(w, r, id)
			}
		case http.MethodDelete:
			if roleLookup != nil {
				RBACMiddleware(roleLookup, RequireAction(contributions.ActionDeleteProject, func(w http.ResponseWriter, r *http.Request) {
					h.HandleDelete(w, r, id)
				}))(w, r)
			} else {
				h.HandleDelete(w, r, id)
			}
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))
}

// HandleCreate handles POST /api/v1/projects
func (h *ProjectsHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var req contributions.CreateProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	project, err := h.service.CreateProject(r.Context(), spaceID, &req)
	if err != nil {
		log.Printf("[Projects] failed to create project: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Projects] project created: %s", project.ID)

	// Notify the creator that their project was created
	if h.notifier != nil && project.CreatedBy != "" {
		h.notifier.Notify(&ContribNotification{
			Type:        "project:created",
			RecipientID: project.CreatedBy,
			Title:       "Project Created",
			Message:     "Project has been created: " + project.Title,
			EntityID:    project.ID,
			EntityType:  "project",
		})
	}

	writeJSON(w, http.StatusCreated, project)
}

// HandleList handles GET /api/v1/projects
func (h *ProjectsHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	projects, err := h.service.ListProjects(r.Context(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"projects": projects, "total": len(projects)})
}

// HandleGet handles GET /api/v1/projects/{id}
func (h *ProjectsHandler) HandleGet(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	project, err := h.service.GetProject(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "project not found"})
		return
	}
	writeJSON(w, http.StatusOK, project)
}

// HandleUpdate handles PUT /api/v1/projects/{id}
func (h *ProjectsHandler) HandleUpdate(w http.ResponseWriter, r *http.Request, id string) {
	var req contributions.UpdateProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	project, err := h.service.UpdateProject(r.Context(), spaceID, id, &req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Projects] project updated: %s", id)
	writeJSON(w, http.StatusOK, project)
}

// HandleDelete handles DELETE /api/v1/projects/{id}
func (h *ProjectsHandler) HandleDelete(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	if err := h.service.DeleteProject(r.Context(), spaceID, id); err != nil {
		log.Printf("[Projects] failed to delete project %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Projects] project deleted: %s", id)
	writeJSON(w, http.StatusOK, map[string]string{"success": "true"})
}

// HandleListProjectContributions handles GET /api/v1/projects/{id}/contributions
func (h *ProjectsHandler) HandleListProjectContributions(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contribs, err := h.service.ListContributionsByProject(r.Context(), spaceID, id)
	if err != nil {
		log.Printf("[Projects] failed to list contributions for project %s: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if contribs == nil {
		contribs = []*contributions.Contribution{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"contributions": contribs,
		"total":         len(contribs),
	})
}

// HandleLinkProposal handles POST /api/v1/projects/{id}/link-proposal
func (h *ProjectsHandler) HandleLinkProposal(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		ProposalID string `json:"proposal_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	project, err := h.service.LinkProposalToProject(r.Context(), spaceID, id, req.ProposalID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, project)
}

// setupTestProjectsHandler creates a handler with mock store for testing.
// roleLookup is nil so RBAC is skipped in tests.
func setupTestProjectsHandler() *ProjectsHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewProjectsHandler(svc, nil, nil)
}
