// backend/internal/contributions/role_store_test.go
package contributions

import (
	"testing"
)

func TestProfileRoleLookup_GetUserRoles(t *testing.T) {
	store := NewMockStore()
	// Simulate a CommunityProfile with role "Operations Steward"
	profile := map[string]interface{}{
		"userAID": "EAbcd1234",
		"role":    "Operations Steward",
	}
	store.Save("readonly-space", "CommunityProfile-EAbcd1234", "CommunityProfile", profile)

	lookup := NewProfileRoleLookup(store, "readonly-space")
	roles, err := lookup.GetUserRoles("EAbcd1234")
	if err != nil {
		t.Fatalf("GetUserRoles failed: %v", err)
	}
	if !HasRole(roles, RoleOperationsSteward) {
		t.Errorf("expected operations_steward in roles, got %v", roles)
	}
	if !HasRole(roles, RoleProjectLead) {
		t.Errorf("expected project_lead in roles (granted by Operations Steward), got %v", roles)
	}
}

// TestProfileRoleLookup_ResolverResolvesAfterSpaceAppears reproduces #174: the
// backend boots before the read-only space exists, so the lookup is constructed
// with an empty space ID. A live resolver must let GetUserRoles resolve the role
// once the space becomes available, without reconstructing the lookup.
func TestProfileRoleLookup_ResolverResolvesAfterSpaceAppears(t *testing.T) {
	store := NewMockStore()
	profile := map[string]interface{}{
		"userAID": "EAdmin1234",
		"role":    "Founding Member",
	}
	store.Save("readonly-space", "CommunityProfile-EAdmin1234", "CommunityProfile", profile)

	// Constructed with an empty space ID, as at boot before an identity exists.
	lookup := NewProfileRoleLookup(store, "")

	// Resolver source starts empty (space not yet created), then becomes populated.
	currentSpace := ""
	lookup.SetSpaceIDResolver(func() string { return currentSpace })

	// Before the space exists, the admin's role cannot be resolved yet.
	roles, err := lookup.GetUserRoles("EAdmin1234")
	if err != nil {
		t.Fatalf("GetUserRoles failed: %v", err)
	}
	if !(len(roles) == 1 && HasRole(roles, RoleMember)) {
		t.Errorf("expected [member] fallback while space empty, got %v", roles)
	}

	// The read-only space is created; the resolver now returns its ID.
	currentSpace = "readonly-space"

	roles, err = lookup.GetUserRoles("EAdmin1234")
	if err != nil {
		t.Fatalf("GetUserRoles failed after space appeared: %v", err)
	}
	if !HasRole(roles, RoleFoundingMember) {
		t.Errorf("expected founding_member resolved via live resolver, got %v", roles)
	}
}

func TestProfileRoleLookup_UnknownUser(t *testing.T) {
	store := NewMockStore()
	lookup := NewProfileRoleLookup(store, "readonly-space")
	roles, err := lookup.GetUserRoles("unknown-aid")
	if err != nil {
		t.Fatalf("expected no error for unknown user, got: %v", err)
	}
	if len(roles) != 1 || !HasRole(roles, RoleMember) {
		t.Errorf("expected [member] fallback for unknown user, got %v", roles)
	}
}
