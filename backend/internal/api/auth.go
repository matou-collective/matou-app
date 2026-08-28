package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/matou-dao/backend/internal/auth"
)

// Rate limits for the public (pre-session) auth endpoints, applied per client
// IP and per AID: a burst of authLimitBurst, refilling at authLimitRate/s.
// Generous for a human or a machine client re-logging on 401, tight enough
// that looping the endpoints cannot brute-force a signature or exhaust the
// challenge store.
const (
	authLimitRate  = 1.0
	authLimitBurst = 20
)

// AuthHandler exposes the signed-challenge login endpoints and holds the
// verifier used by SignedAuthMiddleware.
type AuthHandler struct {
	verifier *auth.Verifier
	byIP     *auth.RateLimiter
	byAID    *auth.RateLimiter
}

// NewAuthHandler creates an AuthHandler around a verifier.
func NewAuthHandler(verifier *auth.Verifier) *AuthHandler {
	return &AuthHandler{
		verifier: verifier,
		byIP:     auth.NewRateLimiter(authLimitRate, authLimitBurst),
		byAID:    auth.NewRateLimiter(authLimitRate, authLimitBurst),
	}
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

// allow applies the per-IP and per-AID rate limits, writing a 429 and
// returning false when either is exceeded.
func (h *AuthHandler) allow(w http.ResponseWriter, r *http.Request, aid string) bool {
	if !h.byIP.Allow(clientIP(r)) || !h.byAID.Allow(aid) {
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many authentication attempts, retry later"})
		return false
	}
	return true
}

// clientIP returns the remote host of the request (no proxy headers: the API
// is loopback-only, so RemoteAddr is authoritative).
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !auth.ValidAID(req.AID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a valid aid is required"})
		return
	}
	if !h.allow(w, r, req.AID) {
		return
	}
	nonce, expiresAt, err := h.verifier.Challenge(req.AID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, auth.ErrChallengeStoreFull) {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]string{"error": "failed to issue challenge"})
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
// POST /api/v1/auth/login {aid, challenge, signature}. The signature must be
// over auth.SignedMessage(aid, challenge), not the bare challenge.
func (h *AuthHandler) HandleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		!auth.ValidAID(req.AID) || req.Challenge == "" || req.Signature == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a valid aid, challenge and signature are required"})
		return
	}
	if !h.allow(w, r, req.AID) {
		return
	}
	token, expiresAt, err := h.verifier.Login(r.Context(), req.AID, req.Challenge, req.Signature)
	if err != nil {
		status := http.StatusUnauthorized
		switch {
		case errors.Is(err, auth.ErrKeyState):
			// Could not reach/parse key state — a server-side dependency issue,
			// not a client auth failure.
			status = http.StatusServiceUnavailable
		case errors.Is(err, auth.ErrUnsupportedKeyState):
			status = http.StatusForbidden
		case errors.Is(err, auth.ErrSessionStoreFull):
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

// verifiedAIDKey is the context key under which SignedAuthMiddleware records
// the AID a request's session token proved control of.
type verifiedAIDKey struct{}

// VerifiedAID returns the AID bound to the request's validated session token,
// or "" when the request carried no valid session. Unlike X-User-AID it is
// never client-supplied, whether or not enforcement is on, so handlers that
// take security-relevant actions on an AID's behalf (session revocation) must
// use it rather than the header.
func VerifiedAID(r *http.Request) string {
	aid, _ := r.Context().Value(verifiedAIDKey{}).(string)
	return aid
}

// withVerifiedAID records aid on the request context.
func withVerifiedAID(r *http.Request, aid string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), verifiedAIDKey{}, aid))
}

// SignedAuthMiddleware validates signed-challenge session tokens and, when
// enforcement is on, is the ONLY thing allowed to populate a trusted X-User-AID.
//
// Regardless of the enforcement flag, a request bearing a valid session token
// has its verified AID recorded on the context (see VerifiedAID).
//
// When enabled, a bearer token falls into one of three cases:
//   - a valid session token: X-User-AID is overwritten with the
//     cryptographically verified AID from the session;
//   - the per-launch API token: treated exactly like "no token" — any
//     client-supplied X-User-AID is stripped and the request passes through as
//     anonymous. The API token is a legitimate bearer the app sends on every
//     backend request before it has a session (boot, first-run, identity/set),
//     and the outer TokenGuardWithSessions has already accepted it; it must not
//     be mistaken for an invalid session and 401'd. It cannot assert a trusted
//     identity, so protected routes still 401 and only public reads serve;
//   - anything else (an unknown/expired token): rejected with 401.
//
// A request with no token has any client-supplied X-User-AID stripped, so it
// reaches RBAC as an anonymous request (protected routes then 401, public read
// routes still serve).
//
// When disabled (default), X-User-AID behaves as before: the header is passed
// through untouched and never rejected.
func SignedAuthMiddleware(sessions *auth.SessionStore, apiToken string, next http.Handler) http.Handler {
	enforced := signedAuthEnabled()
	if enforced {
		log.Println("[Security] Signed-request auth ENFORCED (MATOU_REQUIRE_SIGNED_AUTH set)")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions || authExemptPaths[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		token := bearerToken(r.Header.Get("Authorization"))
		if token == "" {
			if enforced {
				// No proof of identity — do not let a spoofed header through.
				r.Header.Del("X-User-AID")
			}
			next.ServeHTTP(w, r)
			return
		}
		if apiToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(apiToken)) == 1 {
			// The per-launch API token is a legitimate anonymous bearer, not an
			// invalid session: take the same path as "no token".
			if enforced {
				r.Header.Del("X-User-AID")
			}
			next.ServeHTTP(w, r)
			return
		}
		aid, ok := sessions.Validate(token)
		if !ok {
			if enforced {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or expired session"})
				return
			}
			// Not a session and not the API token — nothing to verify.
			next.ServeHTTP(w, r)
			return
		}
		// Bind the request to the verified AID, overriding anything the client
		// claimed in the header.
		r = withVerifiedAID(r, aid)
		r.Header.Set("X-User-AID", aid)
		next.ServeHTTP(w, r)
	})
}
