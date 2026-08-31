package pushrelay

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/matou-dao/backend/internal/auth"
)

// Rate limits for the public (pre-session) auth endpoints, per client IP and
// per AID — mirrors the embedded backend's auth limiter.
const (
	authLimitRate  = 1.0
	authLimitBurst = 20
)

// Config tunes a relay Server.
type Config struct {
	// Verifier drives the signed-challenge login flow the relay reuses from the
	// embedded backend (docs/signed-auth.md). Callers prove control of the AID
	// they register/notify for; the AID is never trusted from a request body.
	Verifier *auth.Verifier
	// Store holds the AID→token map and opt-out flags.
	Store *Store
	// FCM dispatches content-free wake signals.
	FCM FCMSender
	// CoalesceWindow suppresses duplicate recipient+channel pushes within it.
	CoalesceWindow time.Duration
}

// Server is the relay HTTP surface: signed-auth login, register/deregister,
// opt-out and notify.
type Server struct {
	verifier  *auth.Verifier
	store     *Store
	fcm       FCMSender
	coalescer *coalescer
	byIP      *auth.RateLimiter
	byAID     *auth.RateLimiter
}

// NewServer wires a relay Server from Config.
func NewServer(cfg Config) *Server {
	return &Server{
		verifier:  cfg.Verifier,
		store:     cfg.Store,
		fcm:       cfg.FCM,
		coalescer: newCoalescer(cfg.CoalesceWindow),
		byIP:      auth.NewRateLimiter(authLimitRate, authLimitBurst),
		byAID:     auth.NewRateLimiter(authLimitRate, authLimitBurst),
	}
}

// Handler returns the relay's HTTP handler with signed-auth enforced on the
// register/deregister/optout/notify routes. The auth and health routes are
// public (a caller needs them to obtain a session).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/auth/challenge", s.handleChallenge)
	mux.HandleFunc("/auth/login", s.handleLogin)
	mux.Handle("/register", s.requireSession(http.HandlerFunc(s.handleRegister)))
	mux.Handle("/deregister", s.requireSession(http.HandlerFunc(s.handleDeregister)))
	mux.Handle("/optout", s.requireSession(http.HandlerFunc(s.handleOptOut)))
	mux.Handle("/notify", s.requireSession(http.HandlerFunc(s.handleNotify)))
	return mux
}

// contextKey namespaces the verified-AID context value.
type contextKey struct{}

var verifiedAIDKey contextKey

// verifiedAID returns the AID whose session token authenticated the request.
func verifiedAID(r *http.Request) string {
	aid, _ := r.Context().Value(verifiedAIDKey).(string)
	return aid
}

// requireSession is the relay's signed-auth middleware. Unlike the embedded
// backend it is always enforced: the relay is internet-reachable infrastructure
// holding a secret, so an unauthenticated caller must never register or notify.
// A valid session token (minted via the login flow, proving control of an AID's
// current signing key) binds the request to that AID; anything else is 401.
func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r.Header.Get("Authorization"))
		aid, ok := s.verifier.Sessions.Validate(token)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or expired session"})
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), verifiedAIDKey, aid))
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "tokens": s.store.Len()})
}

// --- signed-auth login flow (reused from the embedded backend) ---

func (s *Server) allow(w http.ResponseWriter, r *http.Request, aid string) bool {
	if !s.byIP.Allow(clientIP(r)) || !s.byAID.Allow(aid) {
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many authentication attempts, retry later"})
		return false
	}
	return true
}

func (s *Server) handleChallenge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req struct {
		AID string `json:"aid"`
	}
	if err := decodeStrict(r, &req); err != nil || !auth.ValidAID(req.AID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a valid aid is required"})
		return
	}
	if !s.allow(w, r, req.AID) {
		return
	}
	nonce, expiresAt, err := s.verifier.Challenge(req.AID)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "failed to issue challenge"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"challenge": nonce,
		"expiresAt": expiresAt.UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req struct {
		AID       string `json:"aid"`
		Challenge string `json:"challenge"`
		Signature string `json:"signature"`
	}
	if err := decodeStrict(r, &req); err != nil ||
		!auth.ValidAID(req.AID) || req.Challenge == "" || req.Signature == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a valid aid, challenge and signature are required"})
		return
	}
	if !s.allow(w, r, req.AID) {
		return
	}
	token, expiresAt, err := s.verifier.Login(r.Context(), req.AID, req.Challenge, req.Signature)
	if err != nil {
		status := http.StatusUnauthorized
		switch {
		case errors.Is(err, auth.ErrKeyState):
			status = http.StatusServiceUnavailable
		case errors.Is(err, auth.ErrUnsupportedKeyState):
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"token":     token,
		"expiresAt": expiresAt.UTC().Format(time.RFC3339),
	})
}

// --- registration ---

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req struct {
		Token    string `json:"token"`
		Platform string `json:"platform"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token and platform are required"})
		return
	}
	if req.Token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token is required"})
		return
	}
	if req.Platform == "" {
		req.Platform = "android"
	}
	if err := s.store.Register(verifiedAID(r), req.Token, req.Platform); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to register token"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "registered"})
}

func (s *Server) handleDeregister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if err := decodeStrict(r, &req); err != nil || req.Token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token is required"})
		return
	}
	if err := s.store.Deregister(verifiedAID(r), req.Token); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to deregister token"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deregistered"})
}

func (s *Server) handleOptOut(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req struct {
		OptOut bool `json:"optOut"`
	}
	if err := decodeStrict(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "optOut is required"})
		return
	}
	if err := s.store.SetOptOut(verifiedAID(r), req.OptOut); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to set opt-out"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// --- notify ---

// notifyRequest is the sender's wake signal. DisallowUnknownFields (decodeStrict)
// rejects any extra field, so a sender cannot smuggle message content through
// the relay (§2 content-free invariant). It carries only opaque routing data.
type notifyRequest struct {
	Recipients []string `json:"recipients"`
	Channel    string   `json:"channel"`
	Kind       string   `json:"kind"` // "dm" | "ch"
}

func (s *Server) handleNotify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req notifyRequest
	if err := decodeStrict(r, &req); err != nil {
		// A rejected unknown field lands here: the relay never accepts content.
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid notify body"})
		return
	}
	if len(req.Recipients) == 0 || req.Channel == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "recipients and channel are required"})
		return
	}
	priority, kind, ok := priorityForKind(req.Kind)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind must be dm or ch"})
		return
	}

	var msgs []PushMessage
	dropped := 0
	for _, aid := range req.Recipients {
		if !auth.ValidAID(aid) {
			continue
		}
		if s.store.IsOptedOut(aid) {
			dropped++
			continue
		}
		if !s.coalescer.allow(aid, req.Channel) {
			continue
		}
		for _, rec := range s.store.TokensForAID(aid) {
			msgs = append(msgs, PushMessage{
				Token:    rec.Token,
				Priority: priority,
				Data: map[string]string{
					"t": "m",
					"c": req.Channel,
					"k": kind,
					"v": "1",
				},
			})
		}
	}

	pushed := 0
	if len(msgs) > 0 {
		for _, res := range s.fcm.Send(r.Context(), msgs) {
			switch {
			case res.Unregistered:
				s.store.PruneToken(res.Token)
			case res.Err != nil:
				log.Printf("[push-relay] dispatch failed for token: %v", res.Err)
			default:
				s.store.Touch(res.Token)
				pushed++
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]int{"pushed": pushed, "optedOut": dropped})
}

// priorityForKind maps the coarse kind to an FCM priority and normalised kind
// tag. DMs are high priority (Doze grants a wake window); channel traffic is
// normal priority (batched, quota-friendly) — §2/§4.
func priorityForKind(kind string) (priority, normalised string, ok bool) {
	switch kind {
	case "dm":
		return "high", "dm", true
	case "ch":
		return "normal", "ch", true
	default:
		return "", "", false
	}
}

// --- helpers ---

// decodeStrict decodes a JSON request body rejecting unknown fields, so the
// relay refuses any request carrying fields it does not expect (content
// smuggling defence for /notify, strictness everywhere else).
func decodeStrict(r *http.Request, dst any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func bearerToken(header string) string {
	const prefix = "Bearer "
	if len(header) > len(prefix) && strings.EqualFold(header[:len(prefix)], prefix) {
		return strings.TrimSpace(header[len(prefix):])
	}
	return ""
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
