package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/contributions"
)

// mockOrgConfigProvider implements OrgConfigProvider for tests.
type mockOrgConfigProvider struct {
	config *OrgConfigData
}

func (m *mockOrgConfigProvider) GetConfig() *OrgConfigData {
	return m.config
}

func TestOrgConfigAdminLookup_AdminAID(t *testing.T) {
	provider := &mockOrgConfigProvider{
		config: &OrgConfigData{
			Admins: []AdminData{
				{AID: "EAdmin123", Name: "admin"},
			},
		},
	}
	lookup := NewOrgConfigAdminLookup(provider)

	roles, err := lookup.GetUserRoles("EAdmin123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(roles) == 0 {
		t.Fatal("expected roles for admin AID, got empty")
	}
	if !contributions.HasRole(roles, contributions.RoleFoundingMember) {
		t.Errorf("expected FoundingMember role, got %v", roles)
	}
}

func TestOrgConfigAdminLookup_NonAdminAID(t *testing.T) {
	provider := &mockOrgConfigProvider{
		config: &OrgConfigData{
			Admins: []AdminData{
				{AID: "EAdmin123", Name: "admin"},
			},
		},
	}
	lookup := NewOrgConfigAdminLookup(provider)

	roles, err := lookup.GetUserRoles("ENonAdmin456")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(roles) != 0 {
		t.Errorf("expected empty roles for non-admin, got %v", roles)
	}
}

func TestOrgConfigAdminLookup_NilConfig(t *testing.T) {
	provider := &mockOrgConfigProvider{config: nil}
	lookup := NewOrgConfigAdminLookup(provider)

	roles, err := lookup.GetUserRoles("EAny")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(roles) != 0 {
		t.Errorf("expected empty roles for nil config, got %v", roles)
	}
}

// mockRoleLookup implements RoleLookup for tests.
type mockRoleLookup struct {
	roles map[string][]contributions.Role
}

func (m *mockRoleLookup) GetUserRoles(aid string) ([]contributions.Role, error) {
	return m.roles[aid], nil
}

func TestCompositeRoleLookup_PrimaryWins(t *testing.T) {
	primary := &mockRoleLookup{
		roles: map[string][]contributions.Role{
			"EUser1": {contributions.RoleProjectSteward},
		},
	}
	fallback := &mockRoleLookup{
		roles: map[string][]contributions.Role{
			"EUser1": {contributions.RoleFoundingMember},
		},
	}
	composite := NewCompositeRoleLookup(primary, fallback)

	roles, _ := composite.GetUserRoles("EUser1")
	if !contributions.HasRole(roles, contributions.RoleProjectSteward) {
		t.Errorf("expected primary roles, got %v", roles)
	}
	if contributions.HasRole(roles, contributions.RoleFoundingMember) {
		t.Error("should not have fallback roles when primary returns results")
	}
}

func TestCompositeRoleLookup_FallbackUsed(t *testing.T) {
	primary := &mockRoleLookup{roles: map[string][]contributions.Role{}}
	fallback := &mockRoleLookup{
		roles: map[string][]contributions.Role{
			"EUser1": {contributions.RoleFoundingMember},
		},
	}
	composite := NewCompositeRoleLookup(primary, fallback)

	roles, _ := composite.GetUserRoles("EUser1")
	if !contributions.HasRole(roles, contributions.RoleFoundingMember) {
		t.Errorf("expected fallback roles, got %v", roles)
	}
}

func TestCompositeRoleLookup_AllEmpty(t *testing.T) {
	primary := &mockRoleLookup{roles: map[string][]contributions.Role{}}
	fallback := &mockRoleLookup{roles: map[string][]contributions.Role{}}
	composite := NewCompositeRoleLookup(primary, fallback)

	roles, _ := composite.GetUserRoles("EUnknown")
	if len(roles) != 0 {
		t.Errorf("expected empty roles, got %v", roles)
	}
}

func TestOptionalRBACMiddleware_WithAID(t *testing.T) {
	lookup := &mockRoleLookup{
		roles: map[string][]contributions.Role{
			"EUser1": {contributions.RoleProjectSteward},
		},
	}
	var capturedRoles []contributions.Role
	handler := OptionalRBACMiddleware(lookup, func(w http.ResponseWriter, r *http.Request) {
		capturedRoles = GetUserRoles(r)
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("X-User-AID", "EUser1")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if !contributions.HasRole(capturedRoles, contributions.RoleProjectSteward) {
		t.Errorf("expected roles populated in context, got %v", capturedRoles)
	}
}

// mockIdentityProvider implements IdentityAIDProvider for tests.
type mockIdentityProvider struct {
	aid string
}

func (m *mockIdentityProvider) GetAID() string {
	return m.aid
}

func TestIdentityRoleLookup_MatchingAID(t *testing.T) {
	lookup := NewIdentityRoleLookup(&mockIdentityProvider{aid: "EMyAID123"})
	roles, err := lookup.GetUserRoles("EMyAID123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !contributions.HasRole(roles, contributions.RoleFoundingMember) {
		t.Errorf("expected FoundingMember for identity AID, got %v", roles)
	}
}

func TestIdentityRoleLookup_NonMatchingAID(t *testing.T) {
	lookup := NewIdentityRoleLookup(&mockIdentityProvider{aid: "EMyAID123"})
	roles, err := lookup.GetUserRoles("EOtherAID456")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(roles) != 0 {
		t.Errorf("expected empty roles for non-matching AID, got %v", roles)
	}
}

func TestIdentityRoleLookup_EmptyIdentity(t *testing.T) {
	lookup := NewIdentityRoleLookup(&mockIdentityProvider{aid: ""})
	roles, _ := lookup.GetUserRoles("EAny")
	if len(roles) != 0 {
		t.Errorf("expected empty roles for empty identity, got %v", roles)
	}
}

func TestIdentityRoleLookup_LiveUpdate(t *testing.T) {
	provider := &mockIdentityProvider{aid: ""}
	lookup := NewIdentityRoleLookup(provider)

	// Initially empty — should not match
	roles, _ := lookup.GetUserRoles("EUser1")
	if len(roles) != 0 {
		t.Errorf("expected empty roles before identity set, got %v", roles)
	}

	// Simulate identity being set after startup
	provider.aid = "EUser1"
	roles, _ = lookup.GetUserRoles("EUser1")
	if !contributions.HasRole(roles, contributions.RoleFoundingMember) {
		t.Errorf("expected FoundingMember after identity set, got %v", roles)
	}
}

func TestOptionalRBACMiddleware_WithoutAID(t *testing.T) {
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{}}
	var called bool
	handler := OptionalRBACMiddleware(lookup, func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	// No X-User-AID header
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 (pass-through), got %d", w.Code)
	}
	if !called {
		t.Error("handler should have been called even without AID")
	}
}
