package app

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/api"
	"github.com/matou-dao/backend/internal/identity"
)

// TestRegisterTestOnlyRoutes_OnlyInTestMode pins the security property of the
// #502 backend reset: POST /api/v1/test/reset is mounted ONLY when the raw
// MATOU_ENV value is exactly "test". It bypasses the identity-owner gate, so
// any other environment — dev (""), production, a near-miss spelling — must
// leave the route absent (404 from the bare mux), not merely denied.
func TestRegisterTestOnlyRoutes_OnlyInTestMode(t *testing.T) {
	envs := []struct {
		env        string
		registered bool
	}{
		{env: "", registered: false},
		{env: "production", registered: false},
		{env: "development", registered: false},
		{env: "TEST", registered: false},
		{env: "test ", registered: false},
		{env: "test", registered: true},
	}
	for _, tc := range envs {
		t.Run("MATOU_ENV="+tc.env, func(t *testing.T) {
			ui := identity.New(t.TempDir())
			if err := ui.SetIdentity("EOwner", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"); err != nil {
				t.Fatal(err)
			}
			h := api.NewIdentityHandler(ui, nil, nil, nil)
			mux := http.NewServeMux()
			registerTestOnlyRoutes(mux, Options{Env: tc.env}, h)

			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/test/reset", nil))

			if tc.registered {
				if rec.Code != http.StatusOK {
					t.Fatalf("test mode: reset should be mounted and succeed, got %d: %s", rec.Code, rec.Body.String())
				}
				if ui.IsConfigured() {
					t.Error("test mode: identity should be cleared by the reset")
				}
				return
			}
			if rec.Code != http.StatusNotFound {
				t.Fatalf("env %q: reset route must be ABSENT (404), got %d: %s", tc.env, rec.Code, rec.Body.String())
			}
			if !ui.IsConfigured() {
				t.Error("non-test env: identity must be untouched")
			}
		})
	}
}
