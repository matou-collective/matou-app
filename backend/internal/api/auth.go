package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/matou-dao/backend/internal/auth"
)

// AuthHandler exposes the signed-challenge login endpoints and holds the
// verifier used by SignedAuthMiddleware.
type AuthHandler struct {
	verifier *auth.Verifier
}

// NewAuthHandler creates an AuthHandler around a verifier.
func NewAuthHandler(verifier *auth.Verifier) *AuthHandler {
	return &AuthHandler{verifier: verifier}
}

// Sessions returns the underlying session store (for middleware wiring).
func (h *AuthHandler) Sessions() *auth.SessionStore { return h.verifier.Sessions }

// Verifier returns the underlying verifier (for rotation signalling).
func (h *AuthHandler) Verifier() *auth.Verifier { return h.verifier }

// RegisterRoutes wires the auth endpoints. These are intentionally left out of
// SignedAuthMiddleware's enforced set so a client can obtain a session.
func (h *AuthHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/auth/challenge", CORSHandler(h.HandleChallenge))
	mux.HandleFunc("/api/v1/auth/login", CORSHandler(h.HandleLogin))
}

type challengeRequest struct {
	AID string `json:"aid"`
}

type challengeResponse struct {
	Challenge string `json:"challenge"`
	ExpiresAt string `json:"expiresAt"`
}

// HandleChallenge issues a login challenge: POST /api/v1/auth/challenge {aid}.
func (h *AuthHandler) HandleChallenge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req challengeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "aid is required"})
		return
	}
	nonce, expiresAt, err := h.verifier.Challenge(req.AID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to issue challenge"})
		return
	}
	writeJSON(w, http.StatusOK, challengeResponse{
		Challenge: nonce,
		ExpiresAt: expiresAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	})
}

type loginRequest struct {
	AID       string `json:"aid"`
	Challenge string `json:"challenge"`
	Signature string `json:"signature"`
}

type loginResponse struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
}

// HandleLogin verifies a signed challenge and mints a session token:
// POST /api/v1/auth/login {aid, challenge, signature}.
func (h *AuthHandler) HandleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		req.AID == "" || req.Challenge == "" || req.Signature == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "aid, challenge and signature are required"})
		return
	}
	token, expiresAt, err := h.verifier.Login(r.Context(), req.AID, req.Challenge, req.Signature)
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, auth.ErrKeyState) {
			// Could not reach/parse key state — a server-side dependency issue,
			// not a client auth failure.
			status = http.StatusServiceUnavailable
		}
		log.Printf("[Auth] login failed for %s: %v", req.AID, err)
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, loginResponse{
		Token:     token,
		ExpiresAt: expiresAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	})
}

// signedAuthEnabled reports whether hard enforcement of signed-request auth is
// on. It defaults OFF: the backend keeps accepting a bare X-User-AID header
// until MATOU_REQUIRE_SIGNED_AUTH is set truthy (the Playwright e2e config sets
// it on against real KERIA infrastructure).
func signedAuthEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("MATOU_REQUIRE_SIGNED_AUTH"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// authExemptPaths are reachable without a session token even under enforcement:
// health/info and the login endpoints themselves (a client needs them to obtain
// a token).
var authExemptPaths = map[string]bool{
	"/health":                true,
	"/info":                  true,
	"/api/v1/auth/challenge": true,
	"/api/v1/auth/login":     true,
}

// SignedAuthMiddleware enforces KERI-signed authentication when enabled.
//
// When enabled, it is the ONLY thing allowed to populate a trusted X-User-AID:
//   - a request bearing a valid session token has its X-User-AID overwritten
//     with the cryptographically verified AID from the session;
//   - a request bearing an invalid/expired token is rejected with 401;
//   - a request with no token has any client-supplied X-User-AID stripped, so
//     it reaches RBAC as an anonymous request (protected routes then 401,
//     public read routes still serve).
//
// When disabled (default), it is a pass-through and X-User-AID behaves as
// before.
func SignedAuthMiddleware(sessions *auth.SessionStore, next http.Handler) http.Handler {
	if !signedAuthEnabled() {
		return next
	}
	log.Println("[Security] Signed-request auth ENFORCED (MATOU_REQUIRE_SIGNED_AUTH set)")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions || authExemptPaths[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		token := bearerToken(r.Header.Get("Authorization"))
		if token == "" {
			// No proof of identity — do not let a spoofed header through.
			r.Header.Del("X-User-AID")
			next.ServeHTTP(w, r)
			return
		}
		aid, ok := sessions.Validate(token)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or expired session"})
			return
		}
		// Bind the request to the verified AID, overriding anything the client
		// claimed in the header.
		r.Header.Set("X-User-AID", aid)
		next.ServeHTTP(w, r)
	})
}
