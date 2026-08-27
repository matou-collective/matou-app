package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/matou-dao/backend/internal/contributions"
)

// rbacProfilesMux builds a ProfilesHandler wired with the given role lookup.
func rbacProfilesMux(lookup RoleLookup) *http.ServeMux {
	h := &ProfilesHandler{}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux, lookup)
	return mux
}

func TestMemberRoleChange_RejectedForNonAuthorizedRole(t *testing.T) {
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{
		"EMember": {contributions.RoleMember, contributions.RoleContributor},
	}}
	mux := rbacProfilesMux(lookup)

	req := httptest.NewRequest(http.MethodPut, "/api/v1/members/ETarget/role", strings.NewReader(`{"role":"Contributor"}`))
	req.Header.Set("X-User-AID", "EMember")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for a plain member changing roles, got %d", w.Code)
	}
}

func TestMemberRoleChange_MissingAIDRejected(t *testing.T) {
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{}}
	mux := rbacProfilesMux(lookup)

	req := httptest.NewRequest(http.MethodPut, "/api/v1/members/ETarget/role", strings.NewReader(`{"role":"Contributor"}`))
	// No X-User-AID header.
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 without X-User-AID, got %d", w.Code)
	}
}

func TestPromoteToFoundingMember_RequiresFoundingMember(t *testing.T) {
	// An Operations Steward is authorized to change roles (ActionChangeMemberRole)
	// but must NOT be able to promote anyone to Founding Member.
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{
		"EOps": {contributions.RoleMember, contributions.RoleContributor, contributions.RoleOperationsSteward, contributions.RoleProjectSteward, contributions.RoleProjectLead},
	}}
	mux := rbacProfilesMux(lookup)

	req := httptest.NewRequest(http.MethodPut, "/api/v1/members/ETarget/role", strings.NewReader(`{"role":"Founding Member"}`))
	req.Header.Set("X-User-AID", "EOps")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 when an Operations Steward promotes to Founding Member, got %d", w.Code)
	}
}

func TestRemoveMember_RejectedForNonAuthorizedRole(t *testing.T) {
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{
		"EMember": {contributions.RoleMember, contributions.RoleContributor},
	}}
	mux := rbacProfilesMux(lookup)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/members/ETarget", nil)
	req.Header.Set("X-User-AID", "EMember")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 for a plain member removing a member, got %d", w.Code)
	}
}

// TestTransitionGuard_BlocksSignOffForNonSteward verifies the generic
// /transition endpoint cannot be used to reach signed_off without the
// steward-scoped ActionSignOffContribution permission.
func TestTransitionGuard_BlocksSignOffForNonSteward(t *testing.T) {
	h := setupTestContributionsHandler()
	mux := http.NewServeMux()
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{
		"EMember": {contributions.RoleMember, contributions.RoleContributor},
	}}
	h.RegisterRoutes(mux, lookup)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/contributions/C1/transition", strings.NewReader(`{"status":"signed_off"}`))
	req.Header.Set("X-User-AID", "EMember")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403 transitioning to signed_off as a member, got %d", w.Code)
	}
}

// TestTransitionGuard_AllowsRewardForOpsSteward verifies the reward transition
// passes the guard for an Operations Steward (it then fails downstream because
// the contribution does not exist, which is not a 403).
func TestTransitionGuard_AllowsRewardForOpsSteward(t *testing.T) {
	h := setupTestContributionsHandler()
	mux := http.NewServeMux()
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{
		"EOps": {contributions.RoleOperationsSteward, contributions.RoleFoundingMember},
	}}
	h.RegisterRoutes(mux, lookup)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/contributions/C1/transition", strings.NewReader(`{"status":"rewarded"}`))
	req.Header.Set("X-User-AID", "EOps")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code == http.StatusForbidden {
		t.Errorf("ops steward should pass the reward transition guard, got 403")
	}
}
