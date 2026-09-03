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
	ActionAssignProjectRole, ActionLinkProposal,
	ActionCreateContribution, ActionConfirmContribution, ActionAssignContribution,
	ActionSignOffContribution, ActionRewardContribution,
	ActionTransitionContribution, ActionUpdateContribution,
	ActionShareContribution, ActionOfferContribution, ActionAcceptOffer,
	ActionSubmitEvidence, ActionEditEvidence, ActionReviewContribution, ActionSignOffPlan,
	ActionApproveSubContrib, ActionRegisterInterest,
	ActionChangeMemberRole, ActionRemoveMember, ActionInitMemberProfile, ActionStoreCredential,
	ActionSignOffProposal, ActionRejectProposal, ActionEditProposal, ActionWithdrawProposal,
	ActionArchiveProject, ActionArchiveMilestone, ActionArchiveContribution,
	ActionUnassignContribution, ActionEditMilestone,
	ActionSubmitProjectCompletion, ActionApproveProjectCompletion, ActionRejectProjectCompletion,
	ActionSaveOrgConfig, ActionGrantStewardAdmin, ActionSetIdentity, ActionWriteProfile,
}

// reHomedSinceLegacy lists actions whose capability home was deliberately moved
// after the legacy actionPermissions table was frozen, so their enforcement no
// longer matches the legacy table by design. The equivalence proofs skip them
// and a focused test pins the new behaviour instead.
//
//   - save_org_config: moved from manage_members (adminScope: ops + founder) to
//     manage_community_settings (founder-only) by #318. See
//     TestSaveOrgConfigRequiresManageCommunitySettings.
var reHomedSinceLegacy = map[Action]bool{
	ActionSaveOrgConfig: true,
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
			if reHomedSinceLegacy[action] {
				continue // enforcement deliberately diverges from the legacy table
			}
			legacy := legacyCan(bundle, action)
			viaPolicy := CanPerformActionWithPolicy(p, bundle, action)
			if legacy != viaPolicy {
				t.Errorf("divergence: keriRole=%q action=%q legacy=%v policy=%v",
					kr, action, legacy, viaPolicy)
			}
		}
	}
}

// #318 re-homed save_org_config from manage_members (ops + founder) to
// manage_community_settings (founder-only). The default policy must therefore
// allow only the founder to save org config — an operations steward, who still
// holds manage_members, must be refused.
func TestSaveOrgConfigRequiresManageCommunitySettings(t *testing.T) {
	p := DefaultRolePolicy()
	if !CanPerformActionWithPolicy(p, MapKERIRole("Founding Member"), ActionSaveOrgConfig) {
		t.Error("Founding Member must be able to save org config (holds manage_community_settings)")
	}
	if CanPerformActionWithPolicy(p, MapKERIRole("Operations Steward"), ActionSaveOrgConfig) {
		t.Error("Operations Steward must NOT save org config — it holds manage_members but not manage_community_settings")
	}
	if CanPerformActionWithPolicy(p, MapKERIRole("Member"), ActionSaveOrgConfig) {
		t.Error("Member must NOT save org config")
	}
	// The founder-only default also gates the page-access action.
	if !CanPerformActionWithPolicy(p, MapKERIRole("Founding Member"), ActionOpenCommunitySettings) {
		t.Error("Founding Member must hold open_community_settings by default")
	}
	if CanPerformActionWithPolicy(p, MapKERIRole("Operations Steward"), ActionOpenCommunitySettings) {
		t.Error("Operations Steward must NOT hold open_community_settings by default")
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
	if len(p.Roles) != 7 {
		t.Errorf("default policy has %d roles, want the 7 builtins", len(p.Roles))
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

// The default policy must assign each builtin the scope the Roles &
// Permissions split (#165) expects: project for contributor/lead/steward,
// community for the rest.
func TestDefaultPolicyRoleScopes(t *testing.T) {
	want := map[string]string{
		string(RoleMember):            ScopeCommunity,
		string(RoleContributor):       ScopeProject,
		string(RoleProjectLead):       ScopeProject,
		string(RoleProjectSteward):    ScopeProject,
		string(RoleOperationsSteward): ScopeCommunity,
		string(RoleCommunitySteward):  ScopeCommunity,
		string(RoleFoundingMember):    ScopeCommunity,
	}
	for _, r := range DefaultRolePolicy().Roles {
		if want[r.ID] != r.Scope {
			t.Errorf("role %q scope = %q, want %q", r.ID, r.Scope, want[r.ID])
		}
		if s, ok := BuiltinRoleScope(r.ID); !ok || s != r.Scope {
			t.Errorf("BuiltinRoleScope(%q) = %q,%v; want %q,true", r.ID, s, ok, r.Scope)
		}
	}
}

// Project-scoped roles in the default policy hold only project-scoped
// capabilities, with ONE deliberate exception: project_steward keeps
// manage_governance because the #165 split changes no enforcement — the
// default must reproduce today's grants exactly. The PUT validation
// grandfathers that grant (keep/remove, never re-add or extend); actually
// revoking it is #166's call. If this test fails because a new exception
// appeared, that is an enforcement change — do not add it silently.
func TestDefaultPolicyProjectRolesHoldOnlyProjectCaps(t *testing.T) {
	grandfathered := map[string]map[Capability]bool{
		string(RoleProjectSteward): {CapManageGovernance: true},
	}
	p := DefaultRolePolicy()
	scope := map[string]string{}
	for _, r := range p.Roles {
		scope[r.ID] = r.Scope
	}
	for roleID, caps := range p.Grants {
		if scope[roleID] != ScopeProject {
			continue
		}
		for _, c := range caps {
			if !IsProjectScopedCapability(c) && !grandfathered[roleID][c] {
				t.Errorf("project role %q holds community-only capability %q in the default policy", roleID, c)
			}
		}
	}
}

func TestNormalizeScope(t *testing.T) {
	// Builtins always resolve to their canonical scope, even if asked otherwise.
	if got := NormalizeScope(string(RoleProjectSteward), ScopeCommunity); got != ScopeProject {
		t.Errorf("builtin project_steward normalized to %q, want project", got)
	}
	if got := NormalizeScope(string(RoleMember), ScopeProject); got != ScopeCommunity {
		t.Errorf("builtin member normalized to %q, want community", got)
	}
	// Custom roles: empty defaults to community, project is preserved.
	if got := NormalizeScope("kaitiaki", ""); got != ScopeCommunity {
		t.Errorf("custom empty scope normalized to %q, want community", got)
	}
	if got := NormalizeScope("kaitiaki", ScopeProject); got != ScopeProject {
		t.Errorf("custom project scope normalized to %q, want project", got)
	}
}
