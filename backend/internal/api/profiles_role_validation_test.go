package api

import (
	"testing"
	"time"

	"github.com/matou-dao/backend/internal/contributions"
)

func TestIsAssignableRole(t *testing.T) {
	contributions.SetPolicyProvider(nil)
	t.Cleanup(func() { contributions.SetPolicyProvider(nil) })

	// Builtin KERI roles always assignable.
	if !isAssignableRole("Member") || !isAssignableRole("Operations Steward") {
		t.Error("builtin KERI roles must be assignable")
	}
	// Unknown role: not assignable under default policy.
	if isAssignableRole("kaitiaki") {
		t.Error("unknown role must not be assignable without a policy entry")
	}

	// With a synced policy containing the custom role, it becomes assignable.
	store := contributions.NewMockStore()
	p := contributions.DefaultRolePolicy()
	p.Version = 1
	p.Roles = append(p.Roles, contributions.RoleDef{ID: "kaitiaki", DisplayName: "Kaitiaki"})
	p.Grants["kaitiaki"] = []contributions.Capability{contributions.CapSignOff}
	_ = store.Save("ro-space", "RolePolicy", "RolePolicy", p)
	contributions.SetPolicyProvider(contributions.NewStorePolicyProvider(store, "ro-space", time.Millisecond))

	if !isAssignableRole("kaitiaki") {
		t.Error("custom role in policy must be assignable")
	}
	if isAssignableRole("still_unknown") {
		t.Error("roles absent from policy must stay unassignable")
	}
}
