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

func TestProfileRoleLookup_UnknownUser(t *testing.T) {
	store := NewMockStore()
	lookup := NewProfileRoleLookup(store, "readonly-space")
	roles, err := lookup.GetUserRoles("unknown-aid")
	if err != nil {
		t.Fatalf("expected no error for unknown user, got: %v", err)
	}
	if len(roles) != 0 {
		t.Errorf("expected empty roles for unknown user, got %v", roles)
	}
}
