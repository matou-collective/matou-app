package api

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/auth"
)

// validTestAID is a syntactically valid 44-char AID for handler tests.
const validTestAID = "EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

// testAPIToken is the per-launch API token the middleware is wired with in
// tests (mirrors the value plumbed from opts.APIToken in app wiring).
const testAPIToken = "test-api-token"

// captureAID returns a handler that records the X-User-AID header and the
// context-verified AID it sees.
func captureAID(seen *string, verified *string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen = r.Header.Get("X-User-AID")
		if verified != nil {
			*verified = VerifiedAID(r)
		}
		w.WriteHeader(http.StatusOK)
	})
}

func TestSignedAuthDisabledIsPassthrough(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "")
	sessions := auth.NewSessionStore(0)
	var seen, verified string
	mw := SignedAuthMiddleware(sessions, testAPIToken, captureAID(&seen, &verified))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("X-User-AID", "Eclaimed")
	rr := httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	if seen != "Eclaimed" {
		t.Fatalf("disabled middleware must pass header through, got %q", seen)
	}
	if verified != "" {
		t.Fatalf("no session → no verified AID, got %q", verified)
	}

	// A non-session bearer (the API token) is not rejected when disabled.
	req = httptest.NewRequest(http.MethodPost, "/api/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer matou-dev")
	rr = httptest.NewRecorder()
	mw.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("disabled middleware must not reject a non-session bearer, got %d", rr.Code)
	}
}

// Even with enforcement off, a valid session records the verified AID on the
// context so security-relevant handlers (KEL rotation hook) can rely on it.
func TestSignedAuthDisabledStillVerifiesSessions(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "")
	sessions := auth.NewSessionStore(0)
	token, _, _ := sessions.Mint("Everified", "h1")
	var seen, verified string
	mw := SignedAuthMiddleware(sessions, testAPIToken, captureAID(&seen, &verified))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("X-User-AID", "Espoofed")
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	if verified != "Everified" || seen != "Everified" {
		t.Fatalf("valid session must bind the request to the verified AID, got header=%q verified=%q", seen, verified)
	}
}

func TestSignedAuthEnabledStripsUnverifiedHeader(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "1")
	sessions := auth.NewSessionStore(0)
	var seen string
	mw := SignedAuthMiddleware(sessions, testAPIToken, captureAID(&seen, nil))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("X-User-AID", "Eclaimed") // spoofed, no token
	rr := httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	if seen != "" {
		t.Fatalf("spoofed X-User-AID must be stripped when no token, got %q", seen)
	}
}

func TestSignedAuthEnabledValidToken(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "1")
	sessions := auth.NewSessionStore(0)
	token, _, _ := sessions.Mint("Everified", "h1")

	var seen, verified string
	mw := SignedAuthMiddleware(sessions, testAPIToken, captureAID(&seen, &verified))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("X-User-AID", "Espoofed") // must be overridden
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("valid token should pass, got %d", rr.Code)
	}
	if seen != "Everified" || verified != "Everified" {
		t.Fatalf("verified AID must override client header, got header=%q verified=%q", seen, verified)
	}
}

func TestSignedAuthEnabledInvalidToken(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "1")
	sessions := auth.NewSessionStore(0)

	mw := SignedAuthMiddleware(sessions, testAPIToken, http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatal("handler must not run for an invalid token")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer bogus-token")
	rr := httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("invalid token must be 401, got %d", rr.Code)
	}
}

// The per-launch API token is a legitimate anonymous bearer, not an invalid
// session: under enforcement it must be treated like "no token" — X-User-AID
// stripped, request passed through — rather than 401'd.
func TestSignedAuthEnabledAPITokenIsAnonymous(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "1")
	sessions := auth.NewSessionStore(0)
	var seen, verified string
	mw := SignedAuthMiddleware(sessions, testAPIToken, captureAID(&seen, &verified))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("X-User-AID", "Espoofed") // client-supplied, must be stripped
	req.Header.Set("Authorization", "Bearer "+testAPIToken)
	rr := httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("API token must not 401, got %d", rr.Code)
	}
	if seen != "" {
		t.Fatalf("API-token request must reach RBAC as anonymous (X-User-AID stripped), got %q", seen)
	}
	if verified != "" {
		t.Fatalf("API token must not assert a verified AID, got %q", verified)
	}
}

// A bearer that is neither the API token nor a live session is still rejected
// with 401 under enforcement.
func TestSignedAuthEnabledRandomBearerRejected(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "1")
	sessions := auth.NewSessionStore(0)
	mw := SignedAuthMiddleware(sessions, testAPIToken, http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Fatal("handler must not run for a random bearer")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer not-the-api-token-and-not-a-session")
	rr := httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("random bearer must be 401, got %d", rr.Code)
	}
}

func TestSignedAuthEnabledExemptPaths(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "1")
	sessions := auth.NewSessionStore(0)
	var seen string
	mw := SignedAuthMiddleware(sessions, testAPIToken, captureAID(&seen, nil))

	for _, path := range []string{"/health", "/api/v1/auth/challenge", "/api/v1/auth/login"} {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		rr := httptest.NewRecorder()
		mw.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("exempt path %s should pass without token, got %d", path, rr.Code)
		}
	}
}

// --- handler tests -----------------------------------------------------------

func encodeVerferD(pub ed25519.PublicKey) string {
	raw := make([]byte, 1+len(pub))
	copy(raw[1:], pub)
	return "D" + base64.URLEncoding.EncodeToString(raw)[1:]
}

func encodeSig0B(sig []byte) string {
	raw := make([]byte, 2+len(sig))
	copy(raw[2:], sig)
	return "0B" + base64.URLEncoding.EncodeToString(raw)[2:]
}

func newTestAuthHandler(t *testing.T) (*AuthHandler, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	res := auth.NewStaticKeyStateResolver()
	res.Set(validTestAID, []string{encodeVerferD(pub)})
	v := auth.NewVerifier(res, auth.NewChallengeStore(time.Minute), auth.NewSessionStore(time.Hour))
	return NewAuthHandler(v), priv
}

func postJSON(h http.HandlerFunc, path string, body any, remote string) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = remote
	rr := httptest.NewRecorder()
	h(rr, req)
	return rr
}

func TestAuthHandlerChallengeLoginRoundTrip(t *testing.T) {
	h, priv := newTestAuthHandler(t)

	rr := postJSON(h.HandleChallenge, "/api/v1/auth/challenge", map[string]string{"aid": validTestAID}, "127.0.0.1:1")
	if rr.Code != http.StatusOK {
		t.Fatalf("challenge: %d %s", rr.Code, rr.Body.String())
	}
	var ch challengeResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &ch)

	sig := encodeSig0B(ed25519.Sign(priv, auth.SignedMessage(validTestAID, ch.Challenge)))
	rr = postJSON(h.HandleLogin, "/api/v1/auth/login", map[string]string{
		"aid": validTestAID, "challenge": ch.Challenge, "signature": sig,
	}, "127.0.0.1:1")
	if rr.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rr.Code, rr.Body.String())
	}
	var lr loginResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &lr)
	if aid, ok := h.Sessions().Validate(lr.Token); !ok || aid != validTestAID {
		t.Fatalf("minted token should validate for %s", validTestAID)
	}
}

func TestAuthHandlerRejectsMalformedAID(t *testing.T) {
	h, _ := newTestAuthHandler(t)
	for _, aid := range []string{"", "ETestChallengeAID", "../etc"} {
		rr := postJSON(h.HandleChallenge, "/api/v1/auth/challenge", map[string]string{"aid": aid}, "127.0.0.1:1")
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("aid %q: expected 400, got %d", aid, rr.Code)
		}
		rr = postJSON(h.HandleLogin, "/api/v1/auth/login", map[string]string{"aid": aid, "challenge": "x", "signature": "y"}, "127.0.0.1:1")
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("login aid %q: expected 400, got %d", aid, rr.Code)
		}
	}
}

func TestAuthHandlerRateLimits(t *testing.T) {
	h, _ := newTestAuthHandler(t)
	var last int
	for i := 0; i < authLimitBurst+1; i++ {
		rr := postJSON(h.HandleChallenge, "/api/v1/auth/challenge", map[string]string{"aid": validTestAID}, "127.0.0.1:1")
		last = rr.Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("expected 429 after %d requests, got %d", authLimitBurst+1, last)
	}
	// Another AID from another IP is unaffected... but the per-AID bucket for
	// validTestAID is spent, so a different IP on the same AID is still limited.
	rr := postJSON(h.HandleChallenge, "/api/v1/auth/challenge", map[string]string{"aid": validTestAID}, "127.0.0.2:1")
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("per-AID limit should apply across IPs, got %d", rr.Code)
	}
	other := "EBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	rr = postJSON(h.HandleChallenge, "/api/v1/auth/challenge", map[string]string{"aid": other}, "127.0.0.2:1")
	if rr.Code != http.StatusOK {
		t.Fatalf("other AID from other IP should pass, got %d %s", rr.Code, rr.Body.String())
	}
}

func TestAuthHandlerLoginStatusMapping(t *testing.T) {
	h, priv := newTestAuthHandler(t)
	// Unknown AID → key state unresolvable → 503.
	ghost := "ECCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
	rr := postJSON(h.HandleChallenge, "/api/v1/auth/challenge", map[string]string{"aid": ghost}, "127.0.0.1:1")
	var ch challengeResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &ch)
	rr = postJSON(h.HandleLogin, "/api/v1/auth/login", map[string]string{
		"aid": ghost, "challenge": ch.Challenge, "signature": encodeSig0B(ed25519.Sign(priv, auth.SignedMessage(ghost, ch.Challenge))),
	}, "127.0.0.1:1")
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("unresolvable key state should be 503, got %d", rr.Code)
	}
	// Bogus challenge → 401.
	rr = postJSON(h.HandleLogin, "/api/v1/auth/login", map[string]string{
		"aid": validTestAID, "challenge": "nope", "signature": "sig",
	}, "127.0.0.1:1")
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("bogus challenge should be 401, got %d", rr.Code)
	}
}

// VerifiedAID on a request with no session context is empty (never panics).
func TestVerifiedAIDDefault(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if VerifiedAID(req) != "" {
		t.Fatal("expected empty verified AID")
	}
	req = req.WithContext(context.Background())
	if VerifiedAID(withVerifiedAID(req, "Ex")) != "Ex" {
		t.Fatal("expected verified AID from context")
	}
}
