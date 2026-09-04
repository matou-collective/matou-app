package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/contributions"
)

// noticesRBACMux builds a mux with the notice routes guarded by the given
// role lookup. The handler's spaceManager is nil: every request in this test
// is expected to be rejected by the RBAC layer BEFORE the handler body runs,
// so the nil dependency is never dereferenced.
func noticesRBACMux(lookup RoleLookup) *http.ServeMux {
	h := &NoticesHandler{}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookup)
	return mux
}

// The mutating notice-board routes enforce RBAC (#317): create/publish require
// post_notices; pin/archive require manage_notices. A request with no
// X-User-AID is 401; a caller lacking the capability is 403.
func TestNoticesRBACDenyMatrix(t *testing.T) {
	// "EMember" holds post_notices (member) but NOT manage_notices.
	// "EOutsider" holds neither (no roles).
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{
		"EMember":   contributions.MapKERIRole("Member"),
		"EOutsider": {},
	}}
	mux := noticesRBACMux(lookup)

	cases := []struct {
		name   string
		method string
		path   string
		aid    string
		wantSt int
	}{
		{"create no AID → 401", http.MethodPost, "/api/v1/notices", "", http.StatusUnauthorized},
		{"create outsider → 403", http.MethodPost, "/api/v1/notices", "EOutsider", http.StatusForbidden},
		{"publish no AID → 401", http.MethodPost, "/api/v1/notices/n1/publish", "", http.StatusUnauthorized},
		{"publish outsider → 403", http.MethodPost, "/api/v1/notices/n1/publish", "EOutsider", http.StatusForbidden},
		{"pin no AID → 401", http.MethodPost, "/api/v1/notices/n1/pin", "", http.StatusUnauthorized},
		{"pin member (no manage) → 403", http.MethodPost, "/api/v1/notices/n1/pin", "EMember", http.StatusForbidden},
		{"archive no AID → 401", http.MethodPost, "/api/v1/notices/n1/archive", "", http.StatusUnauthorized},
		{"archive member (no manage) → 403", http.MethodPost, "/api/v1/notices/n1/archive", "EMember", http.StatusForbidden},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(c.method, c.path, nil)
			if c.aid != "" {
				req.Header.Set("X-User-AID", c.aid)
			}
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			if rec.Code != c.wantSt {
				t.Errorf("%s %s (aid=%q) = %d, want %d; body=%s",
					c.method, c.path, c.aid, rec.Code, c.wantSt, rec.Body.String())
			}
		})
	}
}

// Reads stay open: GET /api/v1/notices carries no RBAC guard, so a request
// with no X-User-AID is NOT rejected by the RBAC layer (it reaches the handler,
// which here fails on the nil space manager rather than returning 401/403).
func TestNoticesReadNotGuarded(t *testing.T) {
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{}}
	mux := noticesRBACMux(lookup)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/notices", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code == http.StatusUnauthorized || rec.Code == http.StatusForbidden {
		t.Errorf("GET /api/v1/notices must not be RBAC-gated, got %d", rec.Code)
	}
}
