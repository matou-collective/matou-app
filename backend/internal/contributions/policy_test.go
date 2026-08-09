package contributions

import "testing"

// keriRoles are the 10 KERI credential role strings (keri.ValidRoles()).
var keriRoles = []string{
	"Member", "Contributor", "Community Steward", "Operations Steward",
	"Founding Member", "Financial Steward", "Governance Steward",
	"Treasury Steward", "Technical Steward", "Cultural Steward",
}

// legacyActions: every action present in the legacy actionPermissions table.
var legacyActions = []Action{
	ActionCreateProject, ActionEditProject, ActionDeleteProject,
	ActionCreateContribution, ActionConfirmContribution, ActionAssignContribution,
	ActionApproveContribution, ActionSignOffContribution, ActionRewardContribution,
	ActionShareContribution, ActionOfferContribution, ActionAcceptOffer,
	ActionSubmitEvidence, ActionReviewContribution, ActionSignOffPlan,
	ActionCreateSubContrib, ActionApproveSubContrib, ActionRegisterInterest,
	ActionSignOffProposal, ActionRejectProposal, ActionEditProposal, ActionWithdrawProposal,
	ActionArchiveProject, ActionArchiveMilestone, ActionArchiveContribution,
	ActionUnassignContribution, ActionEditMilestone,
	ActionSubmitProjectCompletion, ActionApproveProjectCompletion, ActionRejectProjectCompletion,
}

// legacyCan checks directly against the legacy actionPermissions table.
// IMPORTANT: do NOT call CanPerformAction here — Task 3 rewires it to
// delegate to the policy, which would make this test compare the policy
// against itself. The raw table is the permanent reference.
func legacyCan(userRoles []Role, action Action) bool {
	allowed, ok := actionPermissions[action]
	if !ok {
		return false
	}
	for _, role := range userRoles {
		for _, a := range allowed {
			if role == a {
				return true
			}
		}
	}
	return false
}

// The default policy must reproduce the legacy table exactly, for every
// KERI role bundle and every legacy action.
func TestDefaultPolicyEquivalentToLegacyTable(t *testing.T) {
	p := DefaultRolePolicy()
	for _, kr := range keriRoles {
		bundle := MapKERIRole(kr)
		for _, action := range legacyActions {
			legacy := legacyCan(bundle, action)
			viaPolicy := CanPerformActionWithPolicy(p, bundle, action)
			if legacy != viaPolicy {
				t.Errorf("divergence: keriRole=%q action=%q legacy=%v policy=%v",
					kr, action, legacy, viaPolicy)
			}
		}
	}
}

func TestDefaultPolicyNewActions(t *testing.T) {
	p := DefaultRolePolicy()
	opsBundle := MapKERIRole("Operations Steward")
	memberBundle := MapKERIRole("Member")
	if !CanPerformActionWithPolicy(p, opsBundle, ActionManageRolePolicy) {
		t.Error("Operations Steward must hold manage_roles by default (spec decision 2)")
	}
	if !CanPerformActionWithPolicy(p, MapKERIRole("Founding Member"), ActionManageRolePolicy) {
		t.Error("Founding Member must hold manage_roles by default")
	}
	if CanPerformActionWithPolicy(p, memberBundle, ActionManageRolePolicy) {
		t.Error("Member must NOT hold manage_roles")
	}
	if !CanPerformActionWithPolicy(p, opsBundle, ActionChangeMemberRole) {
		t.Error("Operations Steward must hold manage_members by default")
	}
	if CanPerformActionWithPolicy(p, memberBundle, ActionChangeMemberRole) {
		t.Error("Member must NOT hold manage_members")
	}
}

func TestDefaultPolicyShape(t *testing.T) {
	p := DefaultRolePolicy()
	if p.Version != 0 {
		t.Errorf("default policy Version = %d, want 0 (0 = built-in, unsaved)", p.Version)
	}
	if len(p.Roles) != 10 {
		t.Errorf("default policy has %d roles, want the 10 builtins", len(p.Roles))
	}
	for _, r := range p.Roles {
		if !r.Builtin {
			t.Errorf("default role %q must be marked Builtin", r.ID)
		}
		if _, ok := p.Grants[r.ID]; !ok {
			t.Errorf("default role %q has no grants entry", r.ID)
		}
	}
	if p.HasCustomRole("member") {
		t.Error("builtin 'member' must not be reported as a custom role")
	}
	if p.HasCustomRole("kaitiaki") {
		t.Error("HasCustomRole must be false for unknown roles")
	}
}

func TestCustomRoleGrants(t *testing.T) {
	p := DefaultRolePolicy()
	p.Roles = append(p.Roles, RoleDef{ID: "kaitiaki", DisplayName: "Kaitiaki", Builtin: false})
	p.Grants["kaitiaki"] = []Capability{CapSignOff}
	if !p.HasCustomRole("kaitiaki") {
		t.Error("kaitiaki should be a custom role")
	}
	userRoles := []Role{RoleMember, Role("kaitiaki")}
	if !CanPerformActionWithPolicy(p, userRoles, ActionSignOffContribution) {
		t.Error("custom role with sign_off grant must be able to sign off contributions")
	}
	if CanPerformActionWithPolicy(p, userRoles, ActionRewardContribution) {
		t.Error("custom role without reward grant must not reward")
	}
}

func TestCanPerformActionWithPolicyUnknownAction(t *testing.T) {
	p := DefaultRolePolicy()
	if CanPerformActionWithPolicy(p, MapKERIRole("Founding Member"), Action("nonexistent")) {
		t.Error("unknown action must be denied even for founding member")
	}
}
