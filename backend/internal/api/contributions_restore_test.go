package api

import (
	"net/http"
	"testing"
)

// POST /contributions/{id}/restore is gated by the archive capability.
func TestRestoreRoute_RequiresArchiveCapability(t *testing.T) {
	h := setupTestContributionsHandler()
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, reviewLookup())

	if w := do(mux, http.MethodPost, "/api/v1/contributions/C1/restore", "EMember", ""); w.Code != http.StatusForbidden {
		t.Fatalf("member restore: want 403, got %d: %s", w.Code, w.Body.String())
	}
	if w := do(mux, http.MethodPost, "/api/v1/contributions/C1/restore", "", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous restore: want 401, got %d", w.Code)
	}
	// An ops steward passes the gate; the missing contribution then fails in
	// the service (400), never 403/401.
	w := do(mux, http.MethodPost, "/api/v1/contributions/C1/restore", "EOps", "")
	if w.Code == http.StatusForbidden || w.Code == http.StatusUnauthorized {
		t.Fatalf("ops steward should pass the gate, got %d: %s", w.Code, w.Body.String())
	}
}
