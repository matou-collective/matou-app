package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/matou-dao/backend/internal/identity"
	"github.com/matou-dao/backend/internal/pairing"
)

// PairingHandler exposes the linked-device pairing protocol
// (internal/pairing) over the loopback API. Every mutating route already sits
// behind the global TokenGuard + LocalhostGuard. GET …/identity hands out the
// mnemonic, and the global TokenGuard lets GETs through, so that one route
// additionally demands the bearer token (or a live session) via authorize —
// otherwise any local process that learned the session id (it travels on the
// unauthenticated SSE stream) could race the frontend for the identity.
type PairingHandler struct {
	manager         *pairing.Manager
	userIdentity    *identity.UserIdentity
	configServerURL string
	authorize       func(r *http.Request) bool
}

// NewPairingHandler builds a pairing handler. manager carries the session state
// machine and mailbox client; configServerURL is this backend's own config
// server, sent to the receiver in the identity message; authorize is the
// bearer check applied to GET …/identity (see BearerAuthorizer). A nil
// authorize fails closed: the identity route then always answers 401.
func NewPairingHandler(manager *pairing.Manager, userIdentity *identity.UserIdentity, configServerURL string, authorize func(r *http.Request) bool) *PairingHandler {
	return &PairingHandler{
		manager:         manager,
		userIdentity:    userIdentity,
		configServerURL: configServerURL,
		authorize:       authorize,
	}
}

// RegisterRoutes registers the pairing routes on the mux.
func (h *PairingHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/pairing/sessions", h.handleSessionsRoot)
	mux.HandleFunc("/api/v1/pairing/scan", h.handleScan)
	mux.HandleFunc("/api/v1/pairing/sessions/", h.handleSessionByID)
}

// localIdentity snapshots this backend's identity for the protocol.
func (h *PairingHandler) localIdentity(deviceName string) pairing.LocalIdentity {
	return pairing.LocalIdentity{
		Configured: h.userIdentity.IsConfigured(),
		AID:        h.userIdentity.GetAID(),
		DeviceName: deviceName,
	}
}

type createSessionRequest struct {
	DeviceName string `json:"deviceName,omitempty"`
}

type createSessionResponse struct {
	SessionID string `json:"sessionId"`
	QRPayload string `json:"qrPayload"`
	ExpiresAt string `json:"expiresAt"`
}

// handleSessionsRoot handles POST /api/v1/pairing/sessions (displayer).
func (h *PairingHandler) handleSessionsRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req createSessionRequest
	_ = json.NewDecoder(r.Body).Decode(&req) // body is optional
	deviceName := firstNonEmpty(req.DeviceName, r.Header.Get("X-User-Name"), "This device")

	view, qr, err := h.manager.CreateDisplayerSession(h.localIdentity(deviceName))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, createSessionResponse{
		SessionID: view.SessionID,
		QRPayload: qr,
		ExpiresAt: view.ExpiresAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	})
}

type scanRequest struct {
	QRPayload  string `json:"qrPayload"`
	DeviceName string `json:"deviceName,omitempty"`
}

type scanResponse struct {
	SessionID      string `json:"sessionId"`
	Outcome        string `json:"outcome"`
	Code           string `json:"code,omitempty"`
	PeerDeviceName string `json:"peerDeviceName,omitempty"`
}

// handleScan handles POST /api/v1/pairing/scan (scanner).
func (h *PairingHandler) handleScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req scanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.QRPayload == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "qrPayload is required"})
		return
	}
	deviceName := firstNonEmpty(req.DeviceName, r.Header.Get("X-User-Name"), "This device")

	view, err := h.manager.Scan(r.Context(), req.QRPayload, deviceName, h.localIdentity(deviceName))
	if err != nil {
		status, body := pairingErrorBody(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, scanResponse{
		SessionID:      view.SessionID,
		Outcome:        string(view.Outcome),
		Code:           view.Code,
		PeerDeviceName: view.PeerDeviceName,
	})
}

type sessionStatusResponse struct {
	State          string `json:"state"`
	Outcome        string `json:"outcome,omitempty"`
	Code           string `json:"code,omitempty"`
	PeerDeviceName string `json:"peerDeviceName,omitempty"`
	Error          string `json:"error,omitempty"`
}

type identityResponse struct {
	Mnemonic        string `json:"mnemonic"`
	AID             string `json:"aid"`
	OrgAID          string `json:"orgAid,omitempty"`
	AdminAID        string `json:"adminAid,omitempty"`
	ConfigServerURL string `json:"configServerUrl,omitempty"`
}

// handleSessionByID routes /api/v1/pairing/sessions/{id} and its subpaths.
func (h *PairingHandler) handleSessionByID(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/pairing/sessions/")
	parts := strings.SplitN(path, "/", 2)
	id := parts[0]
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session id required"})
		return
	}
	sub := ""
	if len(parts) == 2 {
		sub = parts[1]
	}

	switch sub {
	case "":
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		h.handleGetStatus(w, id)
	case "approve":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		h.handleApprove(w, id)
	case "cancel":
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		h.handleCancel(w, r, id)
	case "identity":
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		h.handleGetIdentity(w, r, id)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

func (h *PairingHandler) handleGetStatus(w http.ResponseWriter, id string) {
	view, err := h.manager.View(id)
	if err != nil {
		status, body := pairingErrorBody(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, sessionStatusResponse{
		State:          string(view.State),
		Outcome:        string(view.Outcome),
		Code:           view.Code,
		PeerDeviceName: view.PeerDeviceName,
		Error:          view.Error,
	})
}

func (h *PairingHandler) handleApprove(w http.ResponseWriter, id string) {
	if !h.userIdentity.IsConfigured() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "no identity to approve"})
		return
	}
	holder := pairing.HolderIdentity{
		Mnemonic:        h.userIdentity.GetMnemonic(),
		AID:             h.userIdentity.GetAID(),
		OrgAID:          h.userIdentity.GetOrgAID(),
		ConfigServerURL: h.configServerURL,
	}
	if err := h.manager.Approve(id, holder); err != nil {
		status, body := pairingErrorBody(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "approved"})
}

func (h *PairingHandler) handleCancel(w http.ResponseWriter, r *http.Request, id string) {
	if err := h.manager.Cancel(r.Context(), id); err != nil {
		status, body := pairingErrorBody(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "cancelled"})
}

func (h *PairingHandler) handleGetIdentity(w http.ResponseWriter, r *http.Request, id string) {
	if h.authorize == nil || !h.authorize(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or missing API token"})
		return
	}
	payload, err := h.manager.TakeIdentity(id, h.userIdentity.IsConfigured(), h.userIdentity.GetAID())
	if err != nil {
		status, body := pairingErrorBody(err)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, identityResponse{
		Mnemonic:        payload.Mnemonic,
		AID:             payload.AID,
		OrgAID:          payload.OrgAID,
		AdminAID:        payload.AdminAID,
		ConfigServerURL: payload.ConfigServerURL,
	})
}

// pairingErrorBody maps a pairing error to an HTTP status and JSON body.
func pairingErrorBody(err error) (int, map[string]string) {
	var present *pairing.IdentityPresentError
	switch {
	case errors.As(err, &present):
		return http.StatusConflict, map[string]string{"error": "identity-present", "aid": present.AID}
	case errors.Is(err, pairing.ErrNoSession):
		return http.StatusNotFound, map[string]string{"error": "session not found"}
	case errors.Is(err, pairing.ErrExpired):
		return http.StatusGone, map[string]string{"error": "session expired"}
	case errors.Is(err, pairing.ErrWrongState):
		return http.StatusConflict, map[string]string{"error": "operation not valid in current state"}
	case errors.Is(err, pairing.ErrIdentityUnavailable):
		return http.StatusNotFound, map[string]string{"error": "identity not available"}
	case errors.Is(err, pairing.ErrConfigServerMismatch):
		return http.StatusBadRequest, map[string]string{"error": "config-server-mismatch", "message": err.Error()}
	default:
		return http.StatusInternalServerError, map[string]string{"error": err.Error()}
	}
}

// firstNonEmpty returns the first non-empty string.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
