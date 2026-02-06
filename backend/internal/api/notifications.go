package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"

	"github.com/matou-dao/backend/internal/email"
)

// NotificationsHandler handles notification-related HTTP requests
type NotificationsHandler struct {
	emailSender *email.Sender
}

// NewNotificationsHandler creates a new notifications handler
func NewNotificationsHandler(emailSender *email.Sender) *NotificationsHandler {
	return &NotificationsHandler{
		emailSender: emailSender,
	}
}

// NotificationResponse represents the response from a notification endpoint
type NotificationResponse struct {
	Success bool   `json:"success"`
	Skipped bool   `json:"skipped,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Error   string `json:"error,omitempty"`
}

// RegistrationSubmittedRequest represents a request to notify about a new registration
type RegistrationSubmittedRequest struct {
	ApplicantName    string   `json:"applicantName"`
	ApplicantEmail   string   `json:"applicantEmail"`
	ApplicantAid     string   `json:"applicantAid"`
	Bio              string   `json:"bio"`
	Location         string   `json:"location"`
	JoinReason       string   `json:"joinReason"`
	Interests        []string `json:"interests"`
	CustomInterests  string   `json:"customInterests"`
	SubmittedAt      string   `json:"submittedAt"`
}

// RegistrationApprovedRequest represents a request to notify about an approved registration
type RegistrationApprovedRequest struct {
	ApplicantEmail string `json:"applicantEmail"`
	ApplicantName  string `json:"applicantName"`
}

// HandleRegistrationSubmitted handles POST /api/v1/notifications/registration-submitted
func (h *NotificationsHandler) HandleRegistrationSubmitted(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, NotificationResponse{
			Success: false,
			Error:   "method not allowed",
		})
		return
	}

	var req RegistrationSubmittedRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, NotificationResponse{
			Success: false,
			Error:   fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	// Validate required fields
	if req.ApplicantName == "" {
		writeJSON(w, http.StatusBadRequest, NotificationResponse{
			Success: false,
			Error:   "applicantName is required",
		})
		return
	}
	if req.ApplicantAid == "" {
		writeJSON(w, http.StatusBadRequest, NotificationResponse{
			Success: false,
			Error:   "applicantAid is required",
		})
		return
	}

	// Send the registration notification email
	if err := h.emailSender.SendRegistrationNotification(email.SendRegistrationNotificationRequest{
		ApplicantName:   req.ApplicantName,
		ApplicantEmail:  req.ApplicantEmail,
		ApplicantAid:    req.ApplicantAid,
		Bio:             req.Bio,
		Location:        req.Location,
		JoinReason:      req.JoinReason,
		Interests:       req.Interests,
		CustomInterests: req.CustomInterests,
		SubmittedAt:     req.SubmittedAt,
	}); err != nil {
		writeJSON(w, http.StatusInternalServerError, NotificationResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to send notification: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, NotificationResponse{
		Success: true,
	})
}

// HandleRegistrationApproved handles POST /api/v1/notifications/registration-approved
func (h *NotificationsHandler) HandleRegistrationApproved(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, NotificationResponse{
			Success: false,
			Error:   "method not allowed",
		})
		return
	}

	var req RegistrationApprovedRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, NotificationResponse{
			Success: false,
			Error:   fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	// If no email provided, skip gracefully
	if req.ApplicantEmail == "" {
		writeJSON(w, http.StatusOK, NotificationResponse{
			Success: true,
			Skipped: true,
			Reason:  "no email address provided for applicant",
		})
		return
	}

	// Validate email format
	if _, err := mail.ParseAddress(req.ApplicantEmail); err != nil {
		writeJSON(w, http.StatusBadRequest, NotificationResponse{
			Success: false,
			Error:   "invalid email address",
		})
		return
	}

	name := req.ApplicantName
	if name == "" {
		name = "Member"
	}

	// Send the approval notification email
	if err := h.emailSender.SendApprovalNotification(email.SendApprovalNotificationRequest{
		To:            req.ApplicantEmail,
		ApplicantName: name,
	}); err != nil {
		writeJSON(w, http.StatusInternalServerError, NotificationResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to send notification: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, NotificationResponse{
		Success: true,
	})
}

// RegisterRoutes registers notification routes on the mux
func (h *NotificationsHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/notifications/registration-submitted", CORSHandler(h.HandleRegistrationSubmitted))
	mux.HandleFunc("/api/v1/notifications/registration-approved", CORSHandler(h.HandleRegistrationApproved))
}
