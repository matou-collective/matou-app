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
	notifier     ContribNotifier
}

// NewDecisionPlansHandler creates a new decision plans handler.
// notifier may be nil — notifications are skipped gracefully when not configured.
func NewDecisionPlansHandler(service *contributions.Service, spaceManager *anysync.SpaceManager, notifier ContribNotifier) *DecisionPlansHandler {
	return &DecisionPlansHandler{service: service, spaceManager: spaceManager, notifier: notifier}
}

// RegisterRoutes registers decision plan and governance action routes on the mux.
func (h *DecisionPlansHandler) RegisterRoutes(mux *http.ServeMux, roleLookup RoleLookup) {
	mux.HandleFunc("/api/v1/decision-plans", CORSHandler(OptionalRBACMiddleware(roleLookup, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.HandleList(w, r)
		case http.MethodPost:
			h.HandleCreate(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	})))

	mux.HandleFunc("/api/v1/decision-plans/", CORSHandler(OptionalRBACMiddleware(roleLookup, func(w http.ResponseWriter, r *http.Request) {
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
	})))

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
		if len(parts) == 2 && parts[1] == "archive" && r.Method == http.MethodPost {
			h.HandleArchiveAction(w, r, id)
			return
		}
		if len(parts) == 2 && parts[1] == "vote" && r.Method == http.MethodPost {
			h.HandleCastVote(w, r, id)
			return
		}
		if len(parts) == 2 && parts[1] == "resolve" && r.Method == http.MethodPost {
			h.HandleResolveDecision(w, r, id)
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

	// Sign-off: community admin role OR the plan's assigned proposal steward.
	if contributions.DecisionPlanStatus(req.Status) == contributions.DecisionPlanSignedOff {
		aid := r.Header.Get("X-User-AID")
		if aid == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "X-User-AID header required"})
			return
		}
		roles := GetUserRoles(r)
		isAdmin := contributions.CanPerformAction(roles, contributions.ActionSignOffPlan)
		isAssignedSteward := false
		if !isAdmin {
			existing, err := h.service.GetDecisionPlan(r.Context(), spaceID, id)
			if err != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "decision plan not found"})
				return
			}
			userName := r.Header.Get("X-User-Name")
			isAssignedSteward = existing.ProposalStewardID != "" &&
				(existing.ProposalStewardID == aid || (userName != "" && existing.ProposalStewardID == userName))
		}
		if !isAdmin && !isAssignedSteward {
			log.Printf("[DecisionPlans] sign-off denied for plan %s: aid=%s roles=%v", id, aid, roles)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions: admin role or assigned proposal steward required"})
			return
		}
	}

	dp, err := h.service.TransitionDecisionPlan(r.Context(), spaceID, id, contributions.DecisionPlanStatus(req.Status))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	// Send typed notification based on the new decision plan status
	if h.notifier != nil {
		var notifType, recipientID, title, message string
		switch contributions.DecisionPlanStatus(req.Status) {
		case contributions.DecisionPlanSubmitted:
			// Notify the steward that a plan has been submitted for their sign-off
			if dp.ProposalStewardID != "" {
				notifType = "decision_plan:submitted"
				recipientID = dp.ProposalStewardID
				title = "Decision Plan Submitted"
				message = "A decision plan is ready for sign-off: " + dp.Title
			}
		case contributions.DecisionPlanSignedOff:
			// Notify the proposal lead that the plan has been signed off
			if dp.ProposalLeadID != "" {
				notifType = "decision_plan:signed_off"
				recipientID = dp.ProposalLeadID
				title = "Decision Plan Signed Off"
				message = "Decision plan has been signed off: " + dp.Title
			}
		}
		if notifType != "" && recipientID != "" {
			h.notifier.Notify(&ContribNotification{
				Type:        notifType,
				RecipientID: recipientID,
				Title:       title,
				Message:     message,
				EntityID:    id,
				EntityType:  "decision_plan",
			})
		}
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
		Outcome         string                   `json:"outcome"`
		CompletionNotes string                   `json:"completion_notes"`
		CompletionFiles []contributions.FileRef   `json:"completion_files,omitempty"`
		CompletionLinks []string                  `json:"completion_links,omitempty"`
		VoterName       string                   `json:"voter_name,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	userAID := r.Header.Get("X-User-AID")
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	action, err := h.service.CompleteGovernanceAction(r.Context(), spaceID, actionID, contributions.OutcomeType(req.Outcome), req.CompletionNotes, req.CompletionFiles, req.CompletionLinks, userAID, req.VoterName)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, action)
}

// HandleArchiveAction handles POST /api/v1/governance-actions/{id}/archive
func (h *DecisionPlansHandler) HandleArchiveAction(w http.ResponseWriter, r *http.Request, actionID string) {
	var req struct {
		CompletionNotes string                  `json:"completion_notes"`
		CompletionFiles []contributions.FileRef `json:"completion_files,omitempty"`
		CompletionLinks []string                `json:"completion_links,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	userAID := r.Header.Get("X-User-AID")
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	action, err := h.service.ArchiveGovernanceAction(r.Context(), spaceID, actionID, req.CompletionNotes, req.CompletionFiles, req.CompletionLinks, userAID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, action)
}

// HandleCastVote handles POST /api/v1/governance-actions/{id}/vote
func (h *DecisionPlansHandler) HandleCastVote(w http.ResponseWriter, r *http.Request, actionID string) {
	var req struct {
		Decision  string `json:"decision"`
		Comment   string `json:"comment"`
		VoterName string `json:"voter_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	userAID := r.Header.Get("X-User-AID")
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	action, err := h.service.CastVote(r.Context(), spaceID, actionID, userAID, req.VoterName, contributions.OutcomeType(req.Decision), req.Comment)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, action)
}

// HandleResolveDecision handles POST /api/v1/governance-actions/{id}/resolve
func (h *DecisionPlansHandler) HandleResolveDecision(w http.ResponseWriter, r *http.Request, actionID string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	action, err := h.service.ResolveDecision(r.Context(), spaceID, actionID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, action)
}
