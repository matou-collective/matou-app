package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
)

// ProjectsHandler handles project-related HTTP requests.
type ProjectsHandler struct {
	service      *contributions.Service
	spaceManager *anysync.SpaceManager
	notifier     ContribNotifier
	broker       *EventBroker
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

// SetBroker sets the event broker for SSE broadcasting.
func (h *ProjectsHandler) SetBroker(broker *EventBroker) {
	h.broker = broker
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
			case "assign-role":
				if r.Method == http.MethodPost {
					if roleLookup != nil {
						RBACMiddleware(roleLookup, RequireAction(contributions.ActionCreateProject, func(w http.ResponseWriter, r *http.Request) {
							h.HandleAssignRole(w, r, id)
						}))(w, r)
					} else {
						h.HandleAssignRole(w, r, id)
					}
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
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
			case "archive":
				if r.Method == http.MethodPost {
					if roleLookup != nil {
						RBACMiddleware(roleLookup, RequireAction(contributions.ActionArchiveProject, func(w http.ResponseWriter, r *http.Request) {
							h.HandleArchive(w, r, id)
						}))(w, r)
					} else {
						h.HandleArchive(w, r, id)
					}
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "submit-completion":
				if r.Method == http.MethodPost {
					if roleLookup != nil {
						RBACMiddleware(roleLookup, RequireAction(contributions.ActionSubmitProjectCompletion, func(w http.ResponseWriter, r *http.Request) {
							h.HandleSubmitCompletion(w, r, id)
						}))(w, r)
					} else {
						h.HandleSubmitCompletion(w, r, id)
					}
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "approve-completion":
				if r.Method == http.MethodPost {
					if roleLookup != nil {
						RBACMiddleware(roleLookup, RequireAction(contributions.ActionApproveProjectCompletion, func(w http.ResponseWriter, r *http.Request) {
							h.HandleApproveCompletion(w, r, id)
						}))(w, r)
					} else {
						h.HandleApproveCompletion(w, r, id)
					}
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "reject-completion":
				if r.Method == http.MethodPost {
					if roleLookup != nil {
						RBACMiddleware(roleLookup, RequireAction(contributions.ActionRejectProjectCompletion, func(w http.ResponseWriter, r *http.Request) {
							h.HandleRejectCompletion(w, r, id)
						}))(w, r)
					} else {
						h.HandleRejectCompletion(w, r, id)
					}
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "comments":
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

// HandleAssignRole handles POST /api/v1/projects/{id}/assign-role
func (h *ProjectsHandler) HandleAssignRole(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Role   string `json:"role"`
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Role == "" || req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role and user_id are required"})
		return
	}
	if req.Role != "lead" && req.Role != "steward" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role must be 'lead' or 'steward'"})
		return
	}

	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	project, err := h.service.GetProject(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "project not found"})
		return
	}

	switch req.Role {
	case "lead":
		project.ProjectLeadID = req.UserID
	case "steward":
		project.ProjectStewardID = req.UserID
	}
	project.UpdatedAt = time.Now()

	if err := h.service.SaveProject(r.Context(), spaceID, project); err != nil {
		log.Printf("[Projects] failed to assign role: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to assign role"})
		return
	}

	log.Printf("[Projects] assigned %s to %s on project %s", req.Role, req.UserID, id)
	writeJSON(w, http.StatusOK, project)
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

// HandleArchive handles POST /api/v1/projects/{id}/archive
func (h *ProjectsHandler) HandleArchive(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	if err := h.service.ArchiveProject(r.Context(), spaceID, id); err != nil {
		log.Printf("[Projects] archive failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Projects] project archived: %s", id)
	writeJSON(w, http.StatusOK, map[string]string{"success": "true"})
}

// HandleSubmitCompletion handles POST /api/v1/projects/{id}/submit-completion
func (h *ProjectsHandler) HandleSubmitCompletion(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	leadID := GetUserAID(r)
	proj, err := h.service.SubmitProjectCompletion(r.Context(), spaceID, id, leadID)
	if err != nil {
		log.Printf("[Projects] submit-completion failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Projects] project %s submitted for completion", id)
	writeJSON(w, http.StatusOK, proj)
}

// HandleApproveCompletion handles POST /api/v1/projects/{id}/approve-completion
func (h *ProjectsHandler) HandleApproveCompletion(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	stewardID := GetUserAID(r)
	if stewardID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "X-User-AID header required"})
		return
	}
	proj, err := h.service.ApproveProjectCompletion(r.Context(), spaceID, id, stewardID)
	if err != nil {
		log.Printf("[Projects] approve-completion failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Projects] project %s completion approved by %s", id, stewardID)
	writeJSON(w, http.StatusOK, proj)
}

// HandleRejectCompletion handles POST /api/v1/projects/{id}/reject-completion
func (h *ProjectsHandler) HandleRejectCompletion(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	proj, err := h.service.RejectProjectCompletion(r.Context(), spaceID, id, req.Reason)
	if err != nil {
		log.Printf("[Projects] reject-completion failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Projects] project %s completion rejected", id)
	writeJSON(w, http.StatusOK, proj)
}

// setupTestProjectsHandler creates a handler with mock store for testing.
// roleLookup is nil so RBAC is skipped in tests.
func setupTestProjectsHandler() *ProjectsHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewProjectsHandler(svc, nil, nil)
}

// HandleAddComment handles POST /api/v1/projects/{id}/comments
func (h *ProjectsHandler) HandleAddComment(w http.ResponseWriter, r *http.Request, id string) {
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
	comment := &contributions.ProjectComment{
		ProjectID: id,
		UserID:    req.UserID,
		UserName:  req.UserName,
		Text:      req.Text,
	}
	created, err := h.service.AddProjectComment(r.Context(), spaceID, comment)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if h.broker != nil {
		h.broker.Broadcast(SSEEvent{
			Type: "project:comment_added",
			Data: map[string]string{"project_id": id, "comment_id": created.ID},
		})
	}
	writeJSON(w, http.StatusCreated, created)
}

// HandleListComments handles GET /api/v1/projects/{id}/comments
func (h *ProjectsHandler) HandleListComments(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	comments, err := h.service.ListProjectComments(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"comments": comments,
		"total":    len(comments),
	})
}
