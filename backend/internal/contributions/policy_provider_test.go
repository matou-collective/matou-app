package contributions

import (
	"testing"
	"time"
)

// resetProvider restores the default provider after each test so tests
// don't leak state into each other.
func resetProvider() { SetPolicyProvider(nil) }

func TestCurrentPolicyDefaultsWhenNoProvider(t *testing.T) {
	defer resetProvider()
	SetPolicyProvider(nil)
	p := CurrentPolicy()
	if p == nil || p.Version != 0 {
		t.Fatal("CurrentPolicy must fall back to DefaultRolePolicy when no provider is set")
	}
}

func TestStoreProviderReadsPolicyObject(t *testing.T) {
	defer resetProvider()
	store := NewMockStore()
	custom := DefaultRolePolicy()
	custom.Version = 3
	custom.Roles = append(custom.Roles, RoleDef{ID: "kaitiaki", DisplayName: "Kaitiaki"})
	custom.Grants["kaitiaki"] = []Capability{CapSignOff}
	if err := store.Save("ro-space", "RolePolicy", "RolePolicy", custom); err != nil {
		t.Fatal(err)
	}

	prov := NewStorePolicyProvider(store, "ro-space", time.Millisecond)
	got := prov.Policy()
	if got == nil || got.Version != 3 {
		t.Fatalf("provider returned %+v, want synced policy version 3", got)
	}
	if !got.HasCustomRole("kaitiaki") {
		t.Error("synced policy must include the custom role")
	}
}

func TestStoreProviderFallsBackWhenEmpty(t *testing.T) {
	defer resetProvider()
	prov := NewStorePolicyProvider(NewMockStore(), "ro-space", time.Millisecond)
	if got := prov.Policy(); got != nil {
		t.Errorf("provider with no stored policy must return nil (caller falls back), got %+v", got)
	}
	// Empty space ID → always nil, never a lookup.
	prov2 := NewStorePolicyProvider(NewMockStore(), "", time.Millisecond)
	if got := prov2.Policy(); got != nil {
		t.Error("provider with empty space ID must return nil")
	}
}

func TestStoreProviderCachesWithinTTL(t *testing.T) {
	defer resetProvider()
	store := NewMockStore()
	p := DefaultRolePolicy()
	p.Version = 1
	_ = store.Save("ro-space", "RolePolicy", "RolePolicy", p)
	prov := NewStorePolicyProvider(store, "ro-space", time.Hour)

	if got := prov.Policy(); got == nil || got.Version != 1 {
		t.Fatal("first read should hit the store")
	}
	// Update store; cached value should still be served within TTL.
	p2 := DefaultRolePolicy()
	p2.Version = 2
	_ = store.Save("ro-space", "RolePolicy", "RolePolicy", p2)
	if got := prov.Policy(); got.Version != 1 {
		t.Error("within TTL the cached policy must be served")
	}
	prov.Invalidate()
	if got := prov.Policy(); got.Version != 2 {
		t.Error("after Invalidate the provider must re-read the store")
	}
}

func TestCanPerformActionUsesProvider(t *testing.T) {
	defer resetProvider()
	store := NewMockStore()
	p := DefaultRolePolicy()
	p.Version = 1
	// Take sign_off away from project_steward.
	grants := p.Grants[string(RoleProjectSteward)]
	filtered := grants[:0]
	for _, c := range grants {
		if c != CapSignOff {
			filtered = append(filtered, c)
		}
	}
	p.Grants[string(RoleProjectSteward)] = filtered
	_ = store.Save("ro-space", "RolePolicy", "RolePolicy", p)
	SetPolicyProvider(NewStorePolicyProvider(store, "ro-space", time.Millisecond))

	if CanPerformAction([]Role{RoleProjectSteward}, ActionSignOffContribution) {
		t.Error("edited policy must revoke sign_off from project_steward")
	}
	if !CanPerformAction([]Role{RoleOperationsSteward}, ActionSignOffContribution) {
		t.Error("operations_steward must still sign off")
	}
}

func TestMapKERIRoleResolvesCustomRoles(t *testing.T) {
	defer resetProvider()
	store := NewMockStore()
	p := DefaultRolePolicy()
	p.Version = 1
	p.Roles = append(p.Roles, RoleDef{ID: "kaitiaki", DisplayName: "Kaitiaki"})
	p.Grants["kaitiaki"] = []Capability{CapSignOff}
	_ = store.Save("ro-space", "RolePolicy", "RolePolicy", p)
	SetPolicyProvider(NewStorePolicyProvider(store, "ro-space", time.Millisecond))

	roles := MapKERIRole("kaitiaki")
	want := map[Role]bool{RoleMember: true, Role("kaitiaki"): true}
	if len(roles) != 2 || !want[roles[0]] || !want[roles[1]] {
		t.Errorf("MapKERIRole(kaitiaki) = %v, want [member kaitiaki]", roles)
	}
	// Unknown strings still default to member only.
	if got := MapKERIRole("nonsense"); len(got) != 1 || got[0] != RoleMember {
		t.Errorf("MapKERIRole(nonsense) = %v, want [member]", got)
	}
	// Builtin KERI roles unaffected.
	if got := MapKERIRole("Operations Steward"); len(got) != 5 {
		t.Errorf("MapKERIRole(Operations Steward) = %v, want the 5-role bundle", got)
	}
}
