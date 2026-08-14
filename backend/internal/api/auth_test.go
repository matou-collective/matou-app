package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/auth"
)

// captureAID returns a handler that records the X-User-AID header it sees.
func captureAID(seen *string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen = r.Header.Get("X-User-AID")
		w.WriteHeader(http.StatusOK)
	})
}

func TestSignedAuthDisabledIsPassthrough(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "")
	sessions := auth.NewSessionStore(0)
	var seen string
	mw := SignedAuthMiddleware(sessions, captureAID(&seen))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("X-User-AID", "Eclaimed")
	rr := httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	if seen != "Eclaimed" {
		t.Fatalf("disabled middleware must pass header through, got %q", seen)
	}
}

func TestSignedAuthEnabledStripsUnverifiedHeader(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "1")
	sessions := auth.NewSessionStore(0)
	var seen string
	mw := SignedAuthMiddleware(sessions, captureAID(&seen))

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

	var seen string
	mw := SignedAuthMiddleware(sessions, captureAID(&seen))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil)
	req.Header.Set("X-User-AID", "Espoofed") // must be overridden
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("valid token should pass, got %d", rr.Code)
	}
	if seen != "Everified" {
		t.Fatalf("verified AID must override client header, got %q", seen)
	}
}

func TestSignedAuthEnabledInvalidToken(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "1")
	sessions := auth.NewSessionStore(0)

	mw := SignedAuthMiddleware(sessions, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
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

func TestSignedAuthEnabledExemptPaths(t *testing.T) {
	t.Setenv("MATOU_REQUIRE_SIGNED_AUTH", "1")
	sessions := auth.NewSessionStore(0)
	var seen string
	mw := SignedAuthMiddleware(sessions, captureAID(&seen))

	for _, path := range []string{"/health", "/api/v1/auth/challenge", "/api/v1/auth/login"} {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		rr := httptest.NewRecorder()
		mw.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("exempt path %s should pass without token, got %d", path, rr.Code)
		}
	}
}
