package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
)

// ContribNotifier is a narrow interface used by ContributionsHandler to send
// in-app notifications without importing the notifications package directly
// (which would create an import cycle via notifications/adapters.go).
type ContribNotifier interface {
	Notify(n *ContribNotification) error
}

// ContribNotification is a slim notification type used within the api package
// to avoid importing the full notifications package.
type ContribNotification struct {
	Type        string
	RecipientID string
	Title       string
	Message     string
	EntityID    string
	EntityType  string
}

// ContributionsHandler handles contribution and registration HTTP requests.
type ContributionsHandler struct {
	service      *contributions.Service
	spaceManager *anysync.SpaceManager
	notifier     ContribNotifier
	roleLookup   RoleLookup
	broker       *EventBroker
}

// NewContributionsHandler creates a new contributions handler.
// notifier may be nil — notifications are skipped gracefully when not configured.
func NewContributionsHandler(service *contributions.Service, spaceManager *anysync.SpaceManager, notifier ContribNotifier) *ContributionsHandler {
	return &ContributionsHandler{
		service:      service,
		spaceManager: spaceManager,
		notifier:     notifier,
	}
}

// SetBroker sets the event broker for SSE broadcasting.
func (h *ContributionsHandler) SetBroker(broker *EventBroker) {
	h.broker = broker
}

// RegisterRoutes registers contribution routes on the mux.
// roleLookup is required for RBAC on mutating endpoints; pass nil to skip auth (tests only).
func (h *ContributionsHandler) RegisterRoutes(mux *http.ServeMux, roleLookup RoleLookup) {
	h.roleLookup = roleLookup

	mux.HandleFunc("/api/v1/contributions", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.HandleList(w, r)
		case http.MethodPost:
			h.HandleCreate(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))

	mux.HandleFunc("/api/v1/contributions/", CORSHandler(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/contributions/")
		parts := strings.SplitN(path, "/", 2)
		id := parts[0]
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
			return
		}

		if len(parts) == 2 {
			switch parts[1] {
			case "transition":
				if r.Method == http.MethodPost {
					h.HandleTransition(w, r, id)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "register":
				if r.Method == http.MethodPost {
					h.HandleRegister(w, r, id)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "registrations":
				if r.Method == http.MethodGet {
					h.HandleListRegistrations(w, r, id)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "assign":
				if r.Method == http.MethodPost {
					h.HandleAssign(w, r, id)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "confirm":
				if r.Method == http.MethodPost {
					h.withRBAC(contributions.ActionConfirmContribution, h.HandleConfirm)(w, r)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "share":
				if r.Method == http.MethodPost {
					h.withRBAC(contributions.ActionShareContribution, h.HandleShare)(w, r)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "offer":
				if r.Method == http.MethodPost {
					h.withRBAC(contributions.ActionOfferContribution, h.HandleOffer)(w, r)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "accept-offer":
				if r.Method == http.MethodPost {
					h.withRBAC(contributions.ActionAcceptOffer, h.HandleAcceptOffer)(w, r)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "submit-evidence":
				if r.Method == http.MethodPost {
					h.withRBAC(contributions.ActionSubmitEvidence, h.HandleSubmitEvidence)(w, r)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "review":
				if r.Method == http.MethodPost {
					h.withRBAC(contributions.ActionReviewContribution, h.HandleReview)(w, r)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "sign-off":
				if r.Method == http.MethodPost {
					h.withRBAC(contributions.ActionSignOffContribution, h.HandleSignOff)(w, r)
					return
				}
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
				return
			case "approve-sub":
				if r.Method == http.MethodPost {
					h.withRBAC(contributions.ActionApproveSubContrib, h.HandleApproveSub)(w, r)
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
			h.HandleUpdate(w, r, id)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
	}))
}

// withRBAC applies RBAC middleware when a roleLookup is configured.
// When roleLookup is nil (tests), the handler is invoked directly.
func (h *ContributionsHandler) withRBAC(action contributions.Action, handler http.HandlerFunc) http.HandlerFunc {
	if h.roleLookup == nil {
		return handler
	}
	return RBACMiddleware(h.roleLookup, RequireAction(action, handler))
}

// HandleCreate handles POST /api/v1/contributions
func (h *ContributionsHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var req contributions.CreateContributionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.CreateContribution(r.Context(), spaceID, &req)
	if err != nil {
		log.Printf("[Contributions] failed to create contribution: %v", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution created: %s in project %s", contrib.ID, contrib.ProjectID)
	writeJSON(w, http.StatusCreated, contrib)
}

// HandleList handles GET /api/v1/contributions
func (h *ContributionsHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contribs, err := h.service.ListContributions(r.Context(), spaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"contributions": contribs, "total": len(contribs)})
}

// HandleGet handles GET /api/v1/contributions/{id}
func (h *ContributionsHandler) HandleGet(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.GetContribution(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "contribution not found"})
		return
	}
	writeJSON(w, http.StatusOK, contrib)
}

// HandleTransition handles POST /api/v1/contributions/{id}/transition
func (h *ContributionsHandler) HandleTransition(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.TransitionContribution(r.Context(), spaceID, id, contributions.ContributionStatus(req.Status))
	if err != nil {
		log.Printf("[Contributions] transition failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution %s transitioned to %s", id, req.Status)

	// Notify relevant parties based on the new status
	if h.notifier != nil {
		var notifType, recipientID, title, message string
		switch contributions.ContributionStatus(req.Status) {
		case contributions.ContribNeedsReview:
			// Notify the project lead (creator) that work is ready for review
			if contrib.CreatedBy != "" {
				notifType = "contribution:needs_review"
				recipientID = contrib.CreatedBy
				title = "Contribution Ready for Review"
				message = contrib.Title + " is ready for review"
			}
		case contributions.ContribApproved:
			// Notify the assigned contributor that their work was approved
			if contrib.AssignedContributorID != "" {
				notifType = "contribution:approved"
				recipientID = contrib.AssignedContributorID
				title = "Contribution Approved"
				message = "Your contribution has been approved: " + contrib.Title
			}
		case contributions.ContribDeclined:
			// Notify the assigned contributor that their work was declined
			if contrib.AssignedContributorID != "" {
				notifType = "contribution:declined"
				recipientID = contrib.AssignedContributorID
				title = "Contribution Declined"
				message = "Your contribution was declined: " + contrib.Title
			}
		}
		if notifType != "" && recipientID != "" {
			h.notifier.Notify(&ContribNotification{
				Type:        notifType,
				RecipientID: recipientID,
				Title:       title,
				Message:     message,
				EntityID:    id,
				EntityType:  "contribution",
			})
		}
	}

	writeJSON(w, http.StatusOK, contrib)
}

// HandleUpdate handles PUT /api/v1/contributions/{id}
func (h *ContributionsHandler) HandleUpdate(w http.ResponseWriter, r *http.Request, id string) {
	var req map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.GetContribution(r.Context(), spaceID, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "contribution not found"})
		return
	}
	// Apply updates from request
	if v, ok := req["evidence_submitted"]; ok {
		if evidence, ok := v.([]interface{}); ok {
			contrib.EvidenceSubmitted = make([]string, len(evidence))
			for i, e := range evidence {
				contrib.EvidenceSubmitted[i], _ = e.(string)
			}
		}
	}
	if v, ok := req["completion_notes"].(string); ok {
		contrib.CompletionNotes = v
	}
	if v, ok := req["review_feedback"].(string); ok {
		contrib.ReviewFeedback = v
	}
	if v, ok := req["quality_rating"].(float64); ok {
		contrib.QualityRating = int(v)
	}
	if err := h.service.SaveContribution(r.Context(), spaceID, contrib); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution updated: %s", id)
	writeJSON(w, http.StatusOK, contrib)
}

// HandleRegister handles POST /api/v1/contributions/{id}/register
// Registers a contributor's interest in a contribution and notifies relevant parties.
func (h *ContributionsHandler) HandleRegister(w http.ResponseWriter, r *http.Request, contribID string) {
	var req struct {
		UserID    string `json:"user_id"`
		Statement string `json:"statement"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_id is required"})
		return
	}

	spaceID := resolveCommunitySpaceID(r, h.spaceManager)

	// Get the contribution to find project lead for notification
	contrib, err := h.service.GetContribution(r.Context(), spaceID, contribID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "contribution not found"})
		return
	}

	reg, err := h.service.RegisterInterest(r.Context(), spaceID, contribID, req.UserID, req.Statement)
	if err != nil {
		log.Printf("[Contributions] RegisterInterest failed for %s by %s: %v", contribID, req.UserID, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	log.Printf("[Contributions] %s registered interest in contribution %s", req.UserID, contribID)

	// Notify project lead if a notifier is configured
	if h.notifier != nil && contrib.CreatedBy != "" {
		h.notifier.Notify(&ContribNotification{
			Type:        "contribution:registered",
			RecipientID: contrib.CreatedBy,
			Title:       "New Registration",
			Message:     req.UserID + " registered interest in " + contrib.Title,
			EntityID:    contribID,
			EntityType:  "contribution",
		})
	}

	writeJSON(w, http.StatusCreated, reg)
}

// HandleListRegistrations handles GET /api/v1/contributions/{id}/registrations
func (h *ContributionsHandler) HandleListRegistrations(w http.ResponseWriter, r *http.Request, contribID string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	regs, err := h.service.ListRegistrations(r.Context(), spaceID, contribID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"registrations": regs, "total": len(regs)})
}

// HandleAssign handles POST /api/v1/contributions/{id}/assign
func (h *ContributionsHandler) HandleAssign(w http.ResponseWriter, r *http.Request, contribID string) {
	var req struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_id is required"})
		return
	}

	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.AssignContributor(r.Context(), spaceID, contribID, req.UserID)
	if err != nil {
		log.Printf("[Contributions] AssignContributor failed for %s: %v", contribID, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	log.Printf("[Contributions] contribution %s assigned to %s", contribID, req.UserID)

	// Notify the assigned contributor
	if h.notifier != nil {
		h.notifier.Notify(&ContribNotification{
			Type:        "contribution:assigned",
			RecipientID: req.UserID,
			Title:       "Contribution Assigned",
			Message:     "You have been assigned to: " + contrib.Title,
			EntityID:    contribID,
			EntityType:  "contribution",
		})
	}

	writeJSON(w, http.StatusOK, contrib)
}

// HandleConfirm handles POST /api/v1/contributions/{id}/confirm
// RBAC: ActionConfirmContribution (steward/admin).
func (h *ContributionsHandler) HandleConfirm(w http.ResponseWriter, r *http.Request) {
	id := extractContribID(r, "/api/v1/contributions/", "/confirm")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.ConfirmContribution(r.Context(), spaceID, id)
	if err != nil {
		log.Printf("[Contributions] ConfirmContribution failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution %s confirmed", id)
	if h.broker != nil {
		h.broker.Broadcast(SSEEvent{
			Type: "contribution:confirmed",
			Data: map[string]string{"contribution_id": id},
		})
	}
	writeJSON(w, http.StatusOK, contrib)
}

// HandleShare handles POST /api/v1/contributions/{id}/share
// Body: {"shared_with_roles": [...]}.
// RBAC: ActionShareContribution (lead/steward/admin).
func (h *ContributionsHandler) HandleShare(w http.ResponseWriter, r *http.Request) {
	id := extractContribID(r, "/api/v1/contributions/", "/share")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
		return
	}
	var req struct {
		SharedWithRoles []string `json:"shared_with_roles"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.ShareContribution(r.Context(), spaceID, id, req.SharedWithRoles)
	if err != nil {
		log.Printf("[Contributions] ShareContribution failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution %s shared with roles %v", id, req.SharedWithRoles)
	if h.broker != nil {
		h.broker.Broadcast(SSEEvent{
			Type: "contribution:shared",
			Data: map[string]interface{}{
				"contribution_id":   id,
				"shared_with_roles": req.SharedWithRoles,
			},
		})
	}
	writeJSON(w, http.StatusOK, contrib)
}

// HandleOffer handles POST /api/v1/contributions/{id}/offer
// Body: {"offered_to": "...", "offered_to_name": "..."}.
// RBAC: ActionOfferContribution (lead/steward/admin).
func (h *ContributionsHandler) HandleOffer(w http.ResponseWriter, r *http.Request) {
	id := extractContribID(r, "/api/v1/contributions/", "/offer")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
		return
	}
	var req struct {
		OfferedTo     string `json:"offered_to"`
		OfferedToName string `json:"offered_to_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.OfferedTo == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "offered_to is required"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.OfferContribution(r.Context(), spaceID, id, req.OfferedTo, req.OfferedToName)
	if err != nil {
		log.Printf("[Contributions] OfferContribution failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution %s offered to %s", id, req.OfferedTo)
	if h.notifier != nil {
		h.notifier.Notify(&ContribNotification{
			Type:        "contribution:offered",
			RecipientID: req.OfferedTo,
			Title:       "Contribution Offered",
			Message:     "You have been offered: " + contrib.Title,
			EntityID:    id,
			EntityType:  "contribution",
		})
	}
	writeJSON(w, http.StatusOK, contrib)
}

// HandleAcceptOffer handles POST /api/v1/contributions/{id}/accept-offer
// RBAC: ActionAcceptOffer (contributor/member).
func (h *ContributionsHandler) HandleAcceptOffer(w http.ResponseWriter, r *http.Request) {
	id := extractContribID(r, "/api/v1/contributions/", "/accept-offer")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
		return
	}
	userID := GetUserAID(r)
	if userID == "" {
		// Fallback: read from body for backward compatibility
		var req struct {
			UserID string `json:"user_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil && req.UserID != "" {
			userID = req.UserID
		}
	}
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user identity required (X-User-AID header or user_id body field)"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.AcceptOffer(r.Context(), spaceID, id, userID)
	if err != nil {
		log.Printf("[Contributions] AcceptOffer failed for %s by %s: %v", id, userID, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution %s accepted by %s", id, userID)
	if h.broker != nil {
		h.broker.Broadcast(SSEEvent{
			Type: "contribution:accepted",
			Data: map[string]string{
				"contribution_id": id,
				"user_id":         userID,
			},
		})
	}
	writeJSON(w, http.StatusOK, contrib)
}

// HandleSubmitEvidence handles POST /api/v1/contributions/{id}/submit-evidence
// RBAC: ActionSubmitEvidence (contributor).
func (h *ContributionsHandler) HandleSubmitEvidence(w http.ResponseWriter, r *http.Request) {
	id := extractContribID(r, "/api/v1/contributions/", "/submit-evidence")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
		return
	}
	var req contributions.SubmitEvidenceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.SubmitEvidence(r.Context(), spaceID, id, req)
	if err != nil {
		log.Printf("[Contributions] SubmitEvidence failed for %s: %v", id, err)
		var blockingErr *contributions.BlockingChildrenError
		if errors.As(err, &blockingErr) {
			writeJSON(w, http.StatusConflict, map[string]interface{}{
				"error":              "blocking child contributions",
				"blocking_children":  blockingErr.IDs,
			})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] evidence submitted for %s", id)
	if h.notifier != nil && contrib.CreatedBy != "" {
		h.notifier.Notify(&ContribNotification{
			Type:        "contribution:needs_review",
			RecipientID: contrib.CreatedBy,
			Title:       "Contribution Ready for Review",
			Message:     contrib.Title + " is ready for review",
			EntityID:    id,
			EntityType:  "contribution",
		})
	}
	writeJSON(w, http.StatusOK, contrib)
}

// HandleReview handles POST /api/v1/contributions/{id}/review
// Body: ReviewRequest.
// RBAC: ActionReviewContribution (lead/admin).
func (h *ContributionsHandler) HandleReview(w http.ResponseWriter, r *http.Request) {
	id := extractContribID(r, "/api/v1/contributions/", "/review")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
		return
	}
	var req contributions.ReviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Decision == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "decision is required"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.ReviewContribution(r.Context(), spaceID, id, req)
	if err != nil {
		log.Printf("[Contributions] ReviewContribution failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution %s reviewed: %s", id, req.Decision)
	if h.broker != nil {
		h.broker.Broadcast(SSEEvent{
			Type: "contribution:reviewed",
			Data: map[string]string{
				"contribution_id": id,
				"decision":        req.Decision,
			},
		})
	}
	// Notify contributor of review outcome
	if h.notifier != nil && contrib.AssignedContributorID != "" {
		var notifType, title, message string
		switch req.Decision {
		case "approved":
			notifType = "contribution:approved"
			title = "Contribution Approved"
			message = "Your contribution has been approved: " + contrib.Title
		case "declined":
			notifType = "contribution:declined"
			title = "Contribution Declined"
			message = "Your contribution was declined: " + contrib.Title
		case "incomplete":
			notifType = "contribution:incomplete"
			title = "Contribution Incomplete"
			message = "Your contribution needs more work: " + contrib.Title
		}
		if notifType != "" {
			h.notifier.Notify(&ContribNotification{
				Type:        notifType,
				RecipientID: contrib.AssignedContributorID,
				Title:       title,
				Message:     message,
				EntityID:    id,
				EntityType:  "contribution",
			})
		}
	}
	writeJSON(w, http.StatusOK, contrib)
}

// HandleSignOff handles POST /api/v1/contributions/{id}/sign-off
// RBAC: ActionSignOffContribution (steward/admin).
func (h *ContributionsHandler) HandleSignOff(w http.ResponseWriter, r *http.Request) {
	id := extractContribID(r, "/api/v1/contributions/", "/sign-off")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
		return
	}
	userID := GetUserAID(r)
	if userID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "X-User-AID header required"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.SignOffContribution(r.Context(), spaceID, id, userID)
	if err != nil {
		log.Printf("[Contributions] SignOffContribution failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution %s signed off by %s", id, userID)
	if h.broker != nil {
		h.broker.Broadcast(SSEEvent{
			Type: "contribution:signed_off",
			Data: map[string]string{
				"contribution_id": id,
				"signed_off_by":   userID,
			},
		})
	}
	writeJSON(w, http.StatusOK, contrib)
}

// HandleApproveSub handles POST /api/v1/contributions/{id}/approve-sub
// RBAC: ActionApproveSubContrib (lead/admin).
func (h *ContributionsHandler) HandleApproveSub(w http.ResponseWriter, r *http.Request) {
	id := extractContribID(r, "/api/v1/contributions/", "/approve-sub")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.ApproveSubContribution(r.Context(), spaceID, id)
	if err != nil {
		log.Printf("[Contributions] ApproveSubContribution failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] sub-contribution %s approved", id)
	writeJSON(w, http.StatusOK, contrib)
}

// extractContribID parses the contribution ID from the URL path.
// prefix is the path prefix (e.g. "/api/v1/contributions/") and
// suffix is the sub-resource suffix (e.g. "/confirm").
func extractContribID(r *http.Request, prefix, suffix string) string {
	path := strings.TrimPrefix(r.URL.Path, prefix)
	path = strings.TrimSuffix(path, suffix)
	return path
}

// setupTestContributionsHandler creates a handler with mock store for testing.
func setupTestContributionsHandler() *ContributionsHandler {
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	return NewContributionsHandler(svc, nil, nil)
}
