package api

import (
	"net/http"
	"testing"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/identity"
)

// The test-only reset route (#502) lets a retried e2e org-setup start from a
// clean backend. These tests pin its two load-bearing behaviours:
//
//   - it clears a configured identity WITHOUT the owner/RBAC gate that DELETE
//     /api/v1/identity enforces (the retry's admin is a different owner), and
//   - it forgets the community / read-only / admin space IDs so the next setup
//     seeds fresh spaces instead of inheriting the previous attempt's.
//
// resetMux registers the reset route exactly as app.go does in test mode.
func resetMux(h *IdentityHandler) *http.ServeMux {
	mux := http.NewServeMux()
	h.RegisterTestResetRoute(mux)
	return mux
}

func TestTestReset_ClearsConfiguredIdentityWithoutOwnerGate(t *testing.T) {
	ui := identity.New(t.TempDir())
	// A configured identity: DELETE /api/v1/identity would demand the owner AID
	// (or an admin) here — the reset must succeed regardless, since the caller
	// is not authenticated as anyone.
	if err := ui.SetIdentity("EOwner", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"); err != nil {
		t.Fatal(err)
	}
	if !ui.IsConfigured() {
		t.Fatal("precondition: identity should be configured")
	}

	h := &IdentityHandler{userIdentity: ui}
	mux := resetMux(h)

	// No X-User-AID header at all — a bare, unauthenticated POST.
	if w := do(mux, http.MethodPost, "/api/v1/test/reset", "", ""); w.Code != http.StatusOK {
		t.Fatalf("reset should succeed without any owner auth, got %d: %s", w.Code, w.Body.String())
	}
	if ui.IsConfigured() {
		t.Error("identity should be cleared after reset")
	}
}

func TestTestReset_ForgetsSharedSpaceIDs(t *testing.T) {
	ui := identity.New(t.TempDir())
	// A zero-value SpaceManager exercises the exported Set/Get space-ID
	// accessors without needing a live any-sync client.
	sm := &anysync.SpaceManager{}
	sm.SetCommunitySpaceID("space-community")
	sm.SetCommunityReadOnlySpaceID("space-readonly")
	sm.SetAdminSpaceID("space-admin")
	sm.SetOrgAID("EOrg")

	h := &IdentityHandler{userIdentity: ui, spaceManager: sm}
	mux := resetMux(h)

	if w := do(mux, http.MethodPost, "/api/v1/test/reset", "", ""); w.Code != http.StatusOK {
		t.Fatalf("reset should return 200, got %d: %s", w.Code, w.Body.String())
	}

	if got := sm.GetCommunitySpaceID(); got != "" {
		t.Errorf("community space ID should be forgotten, got %q", got)
	}
	if got := sm.GetCommunityReadOnlySpaceID(); got != "" {
		t.Errorf("read-only space ID should be forgotten, got %q", got)
	}
	if got := sm.GetAdminSpaceID(); got != "" {
		t.Errorf("admin space ID should be forgotten, got %q", got)
	}
	if sm.IsOrgAdmin("EOrg") {
		t.Error("org AID should be forgotten, IsOrgAdmin still reports the old admin")
	}
}

func TestTestReset_RejectsNonPOST(t *testing.T) {
	h := &IdentityHandler{userIdentity: identity.New(t.TempDir())}
	mux := resetMux(h)
	if w := do(mux, http.MethodGet, "/api/v1/test/reset", "", ""); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /api/v1/test/reset should be 405, got %d", w.Code)
	}
}

func TestTestReset_CleanBackendIsNoop(t *testing.T) {
	// First-attempt case: no identity yet. Reset must still succeed (Clear
	// tolerates a missing identity file) so clearTestConfig() can call it
	// unconditionally at the top of every org-setup.
	h := &IdentityHandler{userIdentity: identity.New(t.TempDir())}
	mux := resetMux(h)
	if w := do(mux, http.MethodPost, "/api/v1/test/reset", "", ""); w.Code != http.StatusOK {
		t.Errorf("reset on a clean backend should be a 200 no-op, got %d: %s", w.Code, w.Body.String())
	}
}
