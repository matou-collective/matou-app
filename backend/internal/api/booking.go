package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"
	"time"

	"github.com/matou-dao/backend/internal/email"
)

// BookingHandler handles booking-related HTTP requests
type BookingHandler struct {
	emailSender *email.Sender
}

// NewBookingHandler creates a new booking handler
func NewBookingHandler(emailSender *email.Sender) *BookingHandler {
	return &BookingHandler{
		emailSender: emailSender,
	}
}

// SendBookingEmailRequest represents a request to send a booking confirmation email
type SendBookingEmailRequest struct {
	Email         string `json:"email"`
	Name          string `json:"name"`
	DateTimeUTC   string `json:"dateTimeUTC"`   // ISO 8601 format
	DateTimeNZT   string `json:"dateTimeNZT"`   // Human readable NZT time
	DateTimeLocal string `json:"dateTimeLocal"` // Human readable local time
}

// SendBookingEmailResponse represents the response from sending a booking email
type SendBookingEmailResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// HandleSendEmail handles POST /api/v1/booking/send-email
func (h *BookingHandler) HandleSendEmail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, SendBookingEmailResponse{
			Success: false,
			Error:   "method not allowed",
		})
		return
	}

	var req SendBookingEmailRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, SendBookingEmailResponse{
			Success: false,
			Error:   "invalid request body",
		})
		return
	}

	// Validate required fields
	if req.Email == "" {
		writeJSON(w, http.StatusBadRequest, SendBookingEmailResponse{
			Success: false,
			Error:   "email is required",
		})
		return
	}

	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, SendBookingEmailResponse{
			Success: false,
			Error:   "name is required",
		})
		return
	}

	if req.DateTimeUTC == "" {
		writeJSON(w, http.StatusBadRequest, SendBookingEmailResponse{
			Success: false,
			Error:   "dateTimeUTC is required",
		})
		return
	}

	// Validate email format
	if _, err := mail.ParseAddress(req.Email); err != nil {
		writeJSON(w, http.StatusBadRequest, SendBookingEmailResponse{
			Success: false,
			Error:   "invalid email format",
		})
		return
	}

	// Parse the UTC datetime
	startTime, err := time.Parse(time.RFC3339, req.DateTimeUTC)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, SendBookingEmailResponse{
			Success: false,
			Error:   "invalid dateTimeUTC format",
		})
		return
	}

	// Send the booking confirmation email
	if err := h.emailSender.SendBookingConfirmation(req.Email, req.Name, startTime, req.DateTimeNZT, req.DateTimeLocal); err != nil {
		writeJSON(w, http.StatusInternalServerError, SendBookingEmailResponse{
			Success: false,
			Error:   fmt.Sprintf("failed to send email: %v", err),
		})
		return
	}

	writeJSON(w, http.StatusOK, SendBookingEmailResponse{
		Success: true,
	})
}

// RegisterRoutes registers the booking routes
func (h *BookingHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/booking/send-email", CORSHandler(h.HandleSendEmail))
}
