// backend/internal/contributions/roles_test.go
package contributions

import "testing"

func TestMapKERIRole(t *testing.T) {
	// Existing KERI roles should map to contribution roles
	roles := MapKERIRole("Operations Steward")
	if !HasRole(roles, RoleOperationsSteward) {
		t.Error("expected Operations Steward to map to RoleOperationsSteward")
	}
	// "Community Steward" maps to both community steward AND project steward
	roles = MapKERIRole("Community Steward")
	if !HasRole(roles, RoleCommunitySteward) {
		t.Error("expected Community Steward mapping")
	}
	// Unknown role returns empty
	roles = MapKERIRole("Unknown Role")
	if len(roles) != 0 {
		t.Errorf("expected empty roles for unknown, got %v", roles)
	}
}

func TestCanPerformAction_CreateContribution(t *testing.T) {
	// Operations stewards can create any contribution
	if !CanPerformAction([]Role{RoleOperationsSteward}, ActionCreateContribution) {
		t.Error("ops steward should create contributions")
	}
	// Founding members can create contributions
	if !CanPerformAction([]Role{RoleFoundingMember}, ActionCreateContribution) {
		t.Error("founding member should create contributions")
	}
	// Plain contributor cannot create top-level contributions
	if CanPerformAction([]Role{RoleContributor}, ActionCreateContribution) {
		t.Error("contributor should not create top-level contributions")
	}
}

func TestCanPerformAction_AssignContribution(t *testing.T) {
	if !CanPerformAction([]Role{RoleProjectLead}, ActionAssignContribution) {
		t.Error("project lead should assign")
	}
	if CanPerformAction([]Role{RoleContributor}, ActionAssignContribution) {
		t.Error("contributor should not assign")
	}
}

func TestCanPerformAction_SignOff(t *testing.T) {
	if !CanPerformAction([]Role{RoleProjectSteward}, ActionSignOffContribution) {
		t.Error("project steward should sign off")
	}
	if !CanPerformAction([]Role{RoleOperationsSteward}, ActionSignOffContribution) {
		t.Error("ops steward should sign off")
	}
	if CanPerformAction([]Role{RoleProjectLead}, ActionSignOffContribution) {
		t.Error("project lead should not sign off")
	}
}

func TestCanPerformAction_ApproveContribution(t *testing.T) {
	if !CanPerformAction([]Role{RoleProjectLead}, ActionApproveContribution) {
		t.Error("project lead should approve")
	}
	if CanPerformAction([]Role{RoleContributor}, ActionApproveContribution) {
		t.Error("contributor should not approve")
	}
}

func TestCanPerformAction_RegisterInterest(t *testing.T) {
	if !CanPerformAction([]Role{RoleContributor}, ActionRegisterInterest) {
		t.Error("contributor should register interest")
	}
	if !CanPerformAction([]Role{RoleMember}, ActionRegisterInterest) {
		t.Error("member should register interest")
	}
}
