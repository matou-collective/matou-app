package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/matou-dao/backend/internal/pushrelayclient"
)

// PushRelay is the push-relay surface the handler drives. It has two halves:
// the session-mint round-trips (RelayChallenge/RelaySession) that let the WebView
// sign a challenge the backend spends — "the frontend signs, the backend spends",
// #277 — and the token registration the session then authorises. The caller's AID
// is bound by the relay's signed session, never passed in a body, so a request
// can never spoof another member's AID. Implemented by *pushrelayclient.Client;
// stubbed in tests.
type PushRelay interface {
	RelayChallenge(ctx context.Context, aid string) (challenge string, expiresAt time.Time, err error)
	RelaySession(ctx context.Context, aid, challenge, signature string) (expiresAt time.Time, err error)
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
	relay    PushRelay
	identity PushAIDProvider
}

// NewPushHandler builds the push handler. relay may be nil, in which case the
// register/deregister endpoints report the feature is unconfigured rather than
// forwarding.
func NewPushHandler(relay PushRelay, identity PushAIDProvider) *PushHandler {
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
		if errors.Is(err, pushrelayclient.ErrNoSession) {
			// No live relay session to spend. Answer 401 so the frontend re-mints
			// one (GET relay-challenge → sign → POST relay-session) and retries.
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "push relay session required"})
			return
		}
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
		if errors.Is(err, pushrelayclient.ErrNoSession) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "push relay session required"})
			return
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to deregister with push relay"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deregistered"})
}

// relaySessionRequest is the body of POST /api/v1/push/relay-session: the
// challenge the WebView was handed and the signature it produced over the
// domain-separated message matou-auth:<aid>:<challenge>. No aid field — the AID
// is taken from the authenticated loopback session, never the body, so a caller
// cannot mint a session bound to another member's AID.
type relaySessionRequest struct {
	Challenge string `json:"challenge"`
	Signature string `json:"signature"`
}

// HandleRelayChallenge handles GET /api/v1/push/relay-challenge. It asks the
// relay for a single-use login challenge bound to the caller's AID and returns
// it to the WebView, which signs it with the AID key (the backend cannot sign —
// the signing keys live in signify-ts inside the WebView, see docs/signed-auth.md).
func (h *PushHandler) HandleRelayChallenge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	if h.relay == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "push notifications not configured"})
		return
	}
	aid := h.sessionAID(r)
	if aid == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no authenticated identity"})
		return
	}
	challenge, expiresAt, err := h.relay.RelayChallenge(r.Context(), aid)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to obtain push relay challenge"})
		return
	}
	resp := map[string]string{"aid": aid, "challenge": challenge}
	if !expiresAt.IsZero() {
		resp["expiresAt"] = expiresAt.UTC().Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, resp)
}

// HandleRelaySession handles POST /api/v1/push/relay-session. It forwards the
// WebView's signature to the relay's login, and the relay client keeps the
// resulting bearer token in memory — from then on register/deregister/notify
// spend it. The token is never returned to the WebView or persisted.
func (h *PushHandler) HandleRelaySession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	if h.relay == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "push notifications not configured"})
		return
	}
	aid := h.sessionAID(r)
	if aid == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no authenticated identity"})
		return
	}
	var req relaySessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Challenge == "" || req.Signature == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "challenge and signature are required"})
		return
	}
	expiresAt, err := h.relay.RelaySession(r.Context(), aid, req.Challenge, req.Signature)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to establish push relay session"})
		return
	}
	resp := map[string]string{"status": "ok"}
	if !expiresAt.IsZero() {
		resp["expiresAt"] = expiresAt.UTC().Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, resp)
}

// RegisterRoutes registers the push token routes. Called only when a relay is
// configured, so the endpoints are absent (404) when the feature is dark.
func (h *PushHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/push/relay-challenge", h.HandleRelayChallenge)
	mux.HandleFunc("/api/v1/push/relay-session", h.HandleRelaySession)
	mux.HandleFunc("/api/v1/push/register", h.HandleRegister)
	mux.HandleFunc("/api/v1/push/deregister", h.HandleDeregister)
}
