package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/auth"
)

// TokenGuardWithSessions accepts the API token OR a live signed-auth session
// on mutating requests, and nothing else.
func TestTokenGuardWithSessions(t *testing.T) {
	sessions := auth.NewSessionStore(0)
	session, _, _ := sessions.Mint("Ealice", "h")
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	guard := TokenGuardWithSessions("api-token", sessions, ok)

	cases := []struct {
		name   string
		method string
		bearer string
		want   int
	}{
		{"get without token", http.MethodGet, "", http.StatusOK},
		{"post without token", http.MethodPost, "", http.StatusUnauthorized},
		{"post api token", http.MethodPost, "api-token", http.StatusOK},
		{"post session token", http.MethodPost, session, http.StatusOK},
		{"post bogus token", http.MethodPost, "bogus", http.StatusUnauthorized},
		{"delete session token", http.MethodDelete, session, http.StatusOK},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, "/api/v1/projects", nil)
		if c.bearer != "" {
			req.Header.Set("Authorization", "Bearer "+c.bearer)
		}
		rr := httptest.NewRecorder()
		guard.ServeHTTP(rr, req)
		if rr.Code != c.want {
			t.Errorf("%s: want %d, got %d", c.name, c.want, rr.Code)
		}
	}

	// A revoked session no longer satisfies the guard.
	sessions.RevokeAID("Ealice")
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects", nil)
	req.Header.Set("Authorization", "Bearer "+session)
	rr := httptest.NewRecorder()
	guard.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session must be refused, got %d", rr.Code)
	}
}
