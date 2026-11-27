package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/anystore"
	"github.com/matou-dao/backend/internal/contributions"
)

// TestCredentialRoleLookup_AggregatesAllCredentials proves a member holding
// both a baseline Member credential and an Operations Steward credential
// resolves to the steward bundle regardless of store iteration order (#739):
// the earlier code returned the first match, so a Member credential seen first
// masked the steward one.
func TestCredentialRoleLookup_AggregatesAllCredentials(t *testing.T) {
	tmpDir := t.TempDir()
	store, err := anystore.NewLocalStore(anystore.DefaultConfig(tmpDir))
	if err != nil {
		t.Fatalf("failed to open store: %v", err)
	}
	defer func() { _ = store.Close() }()

	ctx := context.Background()
	aid := "ECherese739"
	creds := []*anystore.CachedCredential{
		{ID: "ECredMember", IssuerAID: "EOrg", SubjectAID: aid, SchemaID: "S",
			Data: map[string]interface{}{"role": "Member"}, CachedAt: time.Now().UTC(), Verified: true},
		{ID: "ECredSteward", IssuerAID: "EOrg", SubjectAID: aid, SchemaID: "S",
			Data: map[string]interface{}{"role": "Operations Steward"}, CachedAt: time.Now().UTC(), Verified: true},
	}
	for _, c := range creds {
		if err := store.StoreCredential(ctx, c); err != nil {
			t.Fatalf("failed to store credential: %v", err)
		}
	}

	lookup := NewCredentialRoleLookup(store)
	roles, err := lookup.GetUserRoles(aid)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !contributions.HasRole(roles, contributions.RoleOperationsSteward) {
		t.Errorf("expected operations_steward from aggregated credentials, got %v", roles)
	}
}

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

// TestUnionRoleLookup_CredentialUpgradesProfile proves the #739 fix: a member
// whose synced CommunityProfile still says Member but who holds an Operations
// Steward credential resolves to the steward role bundle (profile ∪ credential).
func TestUnionRoleLookup_CredentialUpgradesProfile(t *testing.T) {
	profile := &mockRoleLookup{
		roles: map[string][]contributions.Role{
			"ECherese": {contributions.RoleMember},
		},
	}
	credential := &mockRoleLookup{
		roles: map[string][]contributions.Role{
			"ECherese": contributions.MapKERIRole("Operations Steward"),
		},
	}
	union := NewUnionRoleLookup(profile, credential)

	roles, err := union.GetUserRoles("ECherese")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !contributions.HasRole(roles, contributions.RoleOperationsSteward) {
		t.Errorf("expected credential to upgrade role to operations_steward, got %v", roles)
	}
	if !contributions.HasRole(roles, contributions.RoleMember) {
		t.Errorf("expected member role to be retained, got %v", roles)
	}
	if !contributions.IsAdminScope(roles) {
		t.Errorf("expected admin scope so change_member_role is permitted, got %v", roles)
	}
}

// TestUnionRoleLookup_NeverDowngrades proves the union is additive: a credential
// cannot strip a role the profile grants, so it can't be used to self-downgrade
// or lock out an admin.
func TestUnionRoleLookup_NeverDowngrades(t *testing.T) {
	profile := &mockRoleLookup{
		roles: map[string][]contributions.Role{
			"EFounder": contributions.MapKERIRole("Founding Member"),
		},
	}
	credential := &mockRoleLookup{
		roles: map[string][]contributions.Role{
			"EFounder": {contributions.RoleMember},
		},
	}
	union := NewUnionRoleLookup(profile, credential)

	roles, _ := union.GetUserRoles("EFounder")
	if !contributions.HasRole(roles, contributions.RoleFoundingMember) {
		t.Errorf("expected founding_member to be retained despite member credential, got %v", roles)
	}
}

// TestUnionRoleLookup_Dedupes checks the union removes duplicate roles that
// the profile and credential both grant.
func TestUnionRoleLookup_Dedupes(t *testing.T) {
	profile := &mockRoleLookup{roles: map[string][]contributions.Role{
		"EUser": {contributions.RoleMember, contributions.RoleContributor},
	}}
	credential := &mockRoleLookup{roles: map[string][]contributions.Role{
		"EUser": {contributions.RoleMember, contributions.RoleContributor},
	}}
	union := NewUnionRoleLookup(profile, credential)

	roles, _ := union.GetUserRoles("EUser")
	count := 0
	for _, r := range roles {
		if r == contributions.RoleMember {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected member role once after dedupe, got %d in %v", count, roles)
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
	handler := OptionalRBACMiddleware(lookup, func(w http.ResponseWriter, _ *http.Request) {
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
