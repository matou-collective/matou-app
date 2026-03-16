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
}

// NewProjectsHandler creates a new projects handler.
func NewProjectsHandler(service *contributions.Service, spaceManager *anysync.SpaceManager) *ProjectsHandler {
	return &ProjectsHandler{
		service:      service,
		spaceManager: spaceManager,
	}
}

// RegisterRoutes registers project routes on the mux.
func (h *ProjectsHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/projects", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.HandleList(w, r)
		case http.MethodPost:
			h.HandleCreate(w, r)
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

		if len(parts) == 2 && parts[1] == "link-proposal" && r.Method == http.MethodPost {
			h.HandleLinkProposal(w, r, id)
			return
		}

		switch r.Method {
		case http.MethodGet:
			h.HandleGet(w, r, id)
		case http.MethodPut:
			h.HandleUpdate(w, r, id)
		case http.MethodDelete:
			h.HandleDelete(w, r, id)
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
	writeJSON(w, http.StatusCreated, project)
}

// HandleList handles GET /api/v1/projects
// Supports optional ?proposal_id= filter to find the project linked to a specific proposal.
func (h *ProjectsHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	if proposalID := r.URL.Query().Get("proposal_id"); proposalID != "" {
		project, err := h.service.GetProjectByProposalID(r.Context(), spaceID, proposalID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if project != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{"projects": []*contributions.Project{project}, "total": 1})
		} else {
			writeJSON(w, http.StatusOK, map[string]interface{}{"projects": []*contributions.Project{}, "total": 0})
		}
		return
	}

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
func setupTestProjectsHandler() *ProjectsHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewProjectsHandler(svc, nil)
}
