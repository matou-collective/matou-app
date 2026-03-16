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

func TestCanPerformAction_SignOffProposal(t *testing.T) {
	// Admin roles (steward/founding) can sign off proposals
	adminRoles := []struct {
		name string
		role Role
	}{
		{"project_steward", RoleProjectSteward},
		{"operations_steward", RoleOperationsSteward},
		{"community_steward", RoleCommunitySteward},
		{"founding_member", RoleFoundingMember},
	}
	for _, tt := range adminRoles {
		if !CanPerformAction([]Role{tt.role}, ActionSignOffProposal) {
			t.Errorf("%s should be allowed to sign off proposals", tt.name)
		}
	}

	// Non-admin roles cannot sign off proposals
	nonAdminRoles := []struct {
		name string
		role Role
	}{
		{"member", RoleMember},
		{"contributor", RoleContributor},
		{"project_lead", RoleProjectLead},
		{"tech_steward", RoleTechSteward},
		{"treasury_steward", RoleTreasurySteward},
		{"elder_council", RoleElderCouncil},
	}
	for _, tt := range nonAdminRoles {
		if CanPerformAction([]Role{tt.role}, ActionSignOffProposal) {
			t.Errorf("%s should NOT be allowed to sign off proposals", tt.name)
		}
	}

	// No roles at all should be denied
	if CanPerformAction([]Role{}, ActionSignOffProposal) {
		t.Error("empty roles should not be allowed to sign off proposals")
	}
	if CanPerformAction(nil, ActionSignOffProposal) {
		t.Error("nil roles should not be allowed to sign off proposals")
	}
}

func TestCanPerformAction_RejectProposal(t *testing.T) {
	// Admin roles can reject proposals
	adminRoles := []struct {
		name string
		role Role
	}{
		{"project_steward", RoleProjectSteward},
		{"operations_steward", RoleOperationsSteward},
		{"community_steward", RoleCommunitySteward},
		{"founding_member", RoleFoundingMember},
	}
	for _, tt := range adminRoles {
		if !CanPerformAction([]Role{tt.role}, ActionRejectProposal) {
			t.Errorf("%s should be allowed to reject proposals", tt.name)
		}
	}

	// Non-admin roles cannot reject proposals
	nonAdminRoles := []struct {
		name string
		role Role
	}{
		{"member", RoleMember},
		{"contributor", RoleContributor},
		{"project_lead", RoleProjectLead},
	}
	for _, tt := range nonAdminRoles {
		if CanPerformAction([]Role{tt.role}, ActionRejectProposal) {
			t.Errorf("%s should NOT be allowed to reject proposals", tt.name)
		}
	}
}

func TestCanPerformAction_EditProposal(t *testing.T) {
	// Admin roles can edit in_review proposals
	adminRoles := []struct {
		name string
		role Role
	}{
		{"project_steward", RoleProjectSteward},
		{"operations_steward", RoleOperationsSteward},
		{"community_steward", RoleCommunitySteward},
		{"founding_member", RoleFoundingMember},
	}
	for _, tt := range adminRoles {
		if !CanPerformAction([]Role{tt.role}, ActionEditProposal) {
			t.Errorf("%s should be allowed to edit proposals", tt.name)
		}
	}

	// Non-admin roles cannot edit in_review proposals (proposer check is separate)
	nonAdminRoles := []struct {
		name string
		role Role
	}{
		{"member", RoleMember},
		{"contributor", RoleContributor},
		{"project_lead", RoleProjectLead},
	}
	for _, tt := range nonAdminRoles {
		if CanPerformAction([]Role{tt.role}, ActionEditProposal) {
			t.Errorf("%s should NOT be allowed to edit proposals via role alone", tt.name)
		}
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
