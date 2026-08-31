package api

import (
	"context"
	"encoding/json"
	"net/http"
)

// PushRelayRegistrar is the subset of the push-relay client the push handler
// needs: forwarding a device's FCM token registration and deregistration. The
// caller's AID is bound by the relay client's signed session, never passed here
// — so a request body can never spoof another member's AID. Implemented by
// *pushrelayclient.Client; stubbed in tests.
type PushRelayRegistrar interface {
	Register(ctx context.Context, token, platform string) error
	Deregister(ctx context.Context, token string) error
}

// PushAIDProvider reports the locally-configured identity's AID. The embedded
// backend serves a single identity, so this AID is the authenticated session's
// AID. Satisfied by *identity.UserIdentity.
type PushAIDProvider interface {
	GetAID() string
}

// PushHandler serves the loopback push-token registration surface
// (docs/architecture/08-push-notifications.md §8). The frontend only ever talks
// to localhost; this handler forwards to the push-relay over a KERI-signed
// request. When no relay is configured (MATOU_PUSH_RELAY_URL unset) the handler
// is nil-wired at the app layer and its routes are not registered, so the
// feature stays dark on dev/test/Electron.
type PushHandler struct {
	relay    PushRelayRegistrar
	identity PushAIDProvider
}

// NewPushHandler builds the push handler. relay may be nil, in which case the
// register/deregister endpoints report the feature is unconfigured rather than
// forwarding.
func NewPushHandler(relay PushRelayRegistrar, identity PushAIDProvider) *PushHandler {
	return &PushHandler{relay: relay, identity: identity}
}

// pushRegisterRequest is the register/deregister body. It carries ONLY the
// device token and platform — deliberately no aid field: the AID is taken from
// the authenticated session (via the relay client's signer), never the body.
type pushRegisterRequest struct {
	Token    string `json:"token"`
	Platform string `json:"platform"`
}

// sessionAID returns the AID that authenticated this request: the verified
// session AID when signed-auth is on, else the single local identity.
func (h *PushHandler) sessionAID(r *http.Request) string {
	if aid := VerifiedAID(r); aid != "" {
		return aid
	}
	if h.identity != nil {
		return h.identity.GetAID()
	}
	return ""
}

// HandleRegister handles POST /api/v1/push/register.
func (h *PushHandler) HandleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	if h.relay == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "push notifications not configured"})
		return
	}
	if h.sessionAID(r) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no authenticated identity"})
		return
	}

	var req pushRegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token is required"})
		return
	}

	if err := h.relay.Register(r.Context(), req.Token, req.Platform); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to register with push relay"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "registered"})
}

// HandleDeregister handles POST /api/v1/push/deregister.
func (h *PushHandler) HandleDeregister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	if h.relay == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "push notifications not configured"})
		return
	}
	if h.sessionAID(r) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no authenticated identity"})
		return
	}

	var req pushRegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token is required"})
		return
	}

	if err := h.relay.Deregister(r.Context(), req.Token); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to deregister with push relay"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deregistered"})
}

// RegisterRoutes registers the push token routes. Called only when a relay is
// configured, so the endpoints are absent (404) when the feature is dark.
func (h *PushHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/push/register", h.HandleRegister)
	mux.HandleFunc("/api/v1/push/deregister", h.HandleDeregister)
}
