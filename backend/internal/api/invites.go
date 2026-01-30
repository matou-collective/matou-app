package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"

	"github.com/matou-dao/backend/internal/email"
)

// InvitesHandler handles invite-related HTTP requests
type InvitesHandler struct {
	emailSender *email.Sender
}

// NewInvitesHandler creates a new invites handler
func NewInvitesHandler(emailSender *email.Sender) *InvitesHandler {
	return &InvitesHandler{
		emailSender: emailSender,
	}
}

// SendEmailRequest represents a request to email an invite code
type SendEmailRequest struct {
	Email       string `json:"email"`
	InviteCode  string `json:"inviteCode"`
	InviterName string `json:"inviterName"`
	InviteeName string `json:"inviteeName"`
}

// SendEmailResponse represents the response from sending an invite email
type SendEmailResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// HandleSendEmail handles POST /api/v1/invites/send-email
func (h *InvitesHandler) HandleSendEmail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, SendEmailResponse{
			Success: false,
			Error:   "method not allowed",
		})
		return
	}

	var req SendEmailRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, SendEmailResponse{
			Success: false,
			Error:   fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	// Validate required fields
	if req.Email == "" {
		writeJSON(w, http.StatusBadRequest, SendEmailResponse{
			Success: false,
			Error:   "email is required",
		})
		return
	}
	if req.InviteCode == "" {
		writeJSON(w, http.StatusBadRequest, SendEmailResponse{
			Success: false,
			Error:   "inviteCode is required",
		})
		return
	}
	if req.InviterName == "" {
		writeJSON(w, http.StatusBadRequest, SendEmailResponse{
			Success: false,
			Error:   "inviterName is required",
		})
		return
	}
	if req.InviteeName == "" {
		writeJSON(w, http.StatusBadRequest, SendEmailResponse{
			Success: false,
			Error:   "inviteeName is required",
		})
		return
	}

	// Validate email format
	if _, err := mail.ParseAddress(req.Email); err != nil {
		writeJSON(w, http.StatusBadRequest, SendEmailResponse{
			Success: false,
			Error:   "invalid email address",
		})
		return
	}

	// Send the invite email
	if err := h.emailSender.SendInvite(email.SendInviteRequest{
		To:          req.Email,
		InviteCode:  req.InviteCode,
		InviterName: req.InviterName,
		InviteeName: req.InviteeName,
	}); err != nil {
		writeJSON(w, http.StatusInternalServerError, SendEmailResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to send email: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, SendEmailResponse{
		Success: true,
	})
}

// RegisterRoutes registers invite routes on the mux
func (h *InvitesHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/invites/send-email", CORSHandler(h.HandleSendEmail))
}
