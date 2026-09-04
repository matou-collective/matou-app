package contributions

import "testing"

// legacyDefaultPolicy reconstructs the pre-#313 built-in policy: the grant
// structure that used the retired assign_work / manage_communications
// capabilities and the original capability model (CapModel 0). It stands in for
// a community's saved policy written before the #312 capabilities existed, so
// the migration and upgrade path can be exercised against it.
func legacyDefaultPolicy() *RolePolicy {
	base := []Capability{CapContribute, CapManageProjects, CapReviewWork}
	cp := func(extra ...Capability) []Capability {
		return append(append([]Capability{}, base...), extra...)
	}
	return &RolePolicy{
		Version:  5,
		CapModel: 0,
		Roles:    DefaultRolePolicy().Roles, // role registry is unchanged by #313
		Grants: map[string][]Capability{
			string(RoleMember):      cp(),
			string(RoleContributor): cp(),
			string(RoleProjectLead): cp(CapSubmitCompletion, CapArchiveWork),
			string(RoleProjectSteward): cp(CapAssignWork, CapSignOff, CapApproveCompletion,
				CapArchiveWork, CapManageGovernance),
			string(RoleOperationsSteward): cp(CapAssignWork, CapSignOff, CapReward, CapSubmitCompletion,
				CapApproveCompletion, CapArchiveWork, CapManageMembers, CapManageGovernance,
				CapManageComms, CapManageRoles),
			string(RoleCommunitySteward): cp(CapManageGovernance, CapManageComms),
			string(RoleFoundingMember): cp(CapAssignWork, CapSignOff, CapReward, CapSubmitCompletion,
				CapApproveCompletion, CapArchiveWork, CapManageMembers, CapManageGovernance,
				CapManageComms, CapManageRoles),
		},
	}
}

func roleHasCap(p *RolePolicy, roleID string, c Capability) bool {
	for _, g := range p.Grants[roleID] {
		if g == c {
			return true
		}
	}
	return false
}

// Matrix case 1 — fresh default: the built-in default is already at
// CurrentCapModel, carries no retired capability, and is a no-op through the
// migration.
func TestNormalizeStoredPolicyFreshDefault(t *testing.T) {
	p := DefaultRolePolicy()
	if p.CapModel != CurrentCapModel {
		t.Fatalf("default policy CapModel = %d, want %d", p.CapModel, CurrentCapModel)
	}
	if storedPolicyHasRetiredGrant(p) {
		t.Error("default policy must not carry a retired capability")
	}
	NormalizeStoredPolicy(p)
	if p.CapModel != CurrentCapModel {
		t.Errorf("after normalize CapModel = %d, want %d", p.CapModel, CurrentCapModel)
	}
}

// Matrix case 2 — legacy policy + retired caps: assign_work maps to both assign
// capabilities, manage_communications to the two chat moderation capabilities,
// and the retired IDs are dropped.
func TestNormalizeStoredPolicyRetirementMapping(t *testing.T) {
	p := legacyDefaultPolicy()
	NormalizeStoredPolicy(p)

	for _, roleID := range []string{string(RoleProjectSteward), string(RoleOperationsSteward), string(RoleFoundingMember)} {
		if roleHasCap(p, roleID, CapAssignWork) {
			t.Errorf("%s still holds retired assign_work", roleID)
		}
		if !roleHasCap(p, roleID, CapAssignProjectSteward) || !roleHasCap(p, roleID, CapAssignProjectLead) {
			t.Errorf("%s must inherit both assign capabilities from assign_work", roleID)
		}
	}
	for _, roleID := range []string{string(RoleOperationsSteward), string(RoleCommunitySteward), string(RoleFoundingMember)} {
		if roleHasCap(p, roleID, CapManageComms) {
			t.Errorf("%s still holds retired manage_communications", roleID)
		}
		if !roleHasCap(p, roleID, CapManageChannels) || !roleHasCap(p, roleID, CapModerateMessages) {
			t.Errorf("%s must inherit manage_channels + moderate_messages from manage_communications", roleID)
		}
	}
	// project_steward never held manage_communications → must NOT gain the chat
	// moderation caps via the retirement mapping (only via a fresh default, which
	// the merge excludes for successors).
	if roleHasCap(p, string(RoleProjectSteward), CapManageChannels) {
		t.Error("project_steward must not gain manage_channels — it never held manage_communications")
	}
}

// Matrix case 3 — legacy policy + new caps: the default merge fills in the #312
// capabilities for builtin roles so no column starts dark, without touching the
// retirement successors.
func TestNormalizeStoredPolicyUpgradePathMergesDefaults(t *testing.T) {
	p := legacyDefaultPolicy()
	NormalizeStoredPolicy(p)

	if p.CapModel != CurrentCapModel {
		t.Errorf("CapModel after upgrade = %d, want %d", p.CapModel, CurrentCapModel)
	}
	// All community roles gain the member-tier feature caps.
	for _, roleID := range []string{string(RoleMember), string(RoleOperationsSteward), string(RoleCommunitySteward), string(RoleFoundingMember)} {
		for _, c := range communityMemberCaps {
			if !roleHasCap(p, roleID, c) {
				t.Errorf("%s missing merged default %q", roleID, c)
			}
		}
	}
	// Project leads/stewards gain view_contribution_amounts.
	for _, roleID := range []string{string(RoleProjectLead), string(RoleProjectSteward)} {
		if !roleHasCap(p, roleID, CapViewContributionAmounts) {
			t.Errorf("%s missing merged default view_contribution_amounts", roleID)
		}
	}
	// Founder-only community-settings caps reach only the founder.
	if !roleHasCap(p, string(RoleFoundingMember), CapOpenCommunitySettings) ||
		!roleHasCap(p, string(RoleFoundingMember), CapManageCommunitySettings) {
		t.Error("founding_member missing merged community-settings caps")
	}
	if roleHasCap(p, string(RoleOperationsSteward), CapOpenCommunitySettings) {
		t.Error("operations_steward must NOT gain founder-only open_community_settings by default")
	}
	// A project role must not gain a community-scoped feature cap.
	if roleHasCap(p, string(RoleContributor), CapCreateProposals) {
		t.Error("contributor (project role) must not gain community cap create_proposals")
	}
}

// Matrix case 4 — all three combined: the fully migrated legacy default matches
// the built-in default grants exactly (retirement + upgrade compose to the
// current default for a policy that started as the old default).
func TestNormalizeStoredPolicyComposesToCurrentDefault(t *testing.T) {
	p := legacyDefaultPolicy()
	NormalizeStoredPolicy(p)
	def := DefaultRolePolicy()

	for _, role := range def.Roles {
		want := map[Capability]bool{}
		for _, c := range def.Grants[role.ID] {
			want[c] = true
		}
		got := map[Capability]bool{}
		for _, c := range p.Grants[role.ID] {
			got[c] = true
		}
		for c := range want {
			if !got[c] {
				t.Errorf("migrated %s missing %q present in the current default", role.ID, c)
			}
		}
		for c := range got {
			if !want[c] {
				t.Errorf("migrated %s has %q not in the current default", role.ID, c)
			}
		}
	}
}

// The upgrade path must not resurrect a retired grant an admin had removed: a
// legacy policy where only project_steward kept assign_work migrates to
// project_steward holding the assign caps, while operations_steward — which had
// assign_work removed — does NOT regain them.
func TestNormalizeStoredPolicyDoesNotResurrectRemovedRetiredGrant(t *testing.T) {
	p := legacyDefaultPolicy()
	// Strip assign_work (and manage_communications) from operations_steward.
	var trimmed []Capability
	for _, c := range p.Grants[string(RoleOperationsSteward)] {
		if c != CapAssignWork && c != CapManageComms {
			trimmed = append(trimmed, c)
		}
	}
	p.Grants[string(RoleOperationsSteward)] = trimmed
	NormalizeStoredPolicy(p)

	if roleHasCap(p, string(RoleOperationsSteward), CapAssignProjectSteward) ||
		roleHasCap(p, string(RoleOperationsSteward), CapAssignProjectLead) {
		t.Error("operations_steward regained assign caps it had removed — the merge resurrected a retired grant")
	}
	if roleHasCap(p, string(RoleOperationsSteward), CapManageChannels) ||
		roleHasCap(p, string(RoleOperationsSteward), CapModerateMessages) {
		t.Error("operations_steward regained chat caps it had removed via manage_communications")
	}
	// project_steward, which kept assign_work, still inherits the assign caps.
	if !roleHasCap(p, string(RoleProjectSteward), CapAssignProjectSteward) {
		t.Error("project_steward must still inherit assign_project_steward from assign_work")
	}
}

// The retirement mapping applies to custom roles too, but the default merge does
// not (a custom role has no default grants) — so a custom role keeps exactly its
// mapped successors and gains no new-capability defaults.
func TestNormalizeStoredPolicyCustomRole(t *testing.T) {
	p := legacyDefaultPolicy()
	p.Roles = append(p.Roles, RoleDef{ID: "kaitiaki", DisplayName: "Kaitiaki", Scope: ScopeCommunity})
	p.Grants["kaitiaki"] = []Capability{CapManageComms, CapSignOff}
	NormalizeStoredPolicy(p)

	if roleHasCap(p, "kaitiaki", CapManageComms) {
		t.Error("custom role still holds retired manage_communications")
	}
	if !roleHasCap(p, "kaitiaki", CapManageChannels) || !roleHasCap(p, "kaitiaki", CapModerateMessages) {
		t.Error("custom role must inherit the manage_communications successors")
	}
	if roleHasCap(p, "kaitiaki", CapCreateProposals) {
		t.Error("custom role must not gain a new-capability default it was never granted")
	}
	if !roleHasCap(p, "kaitiaki", CapSignOff) {
		t.Error("custom role's unrelated grant must be preserved")
	}
}

// The core no-enforcement-change proof for migrated policies: a legacy saved
// policy, once normalized, resolves EVERY legacy action identically to the raw
// pre-change permission table, for every KERI role bundle. This is the stored-
// policy analogue of TestDefaultPolicyEquivalentToLegacyTable.
func TestNormalizedLegacyPolicyEnforcementUnchanged(t *testing.T) {
	p := legacyDefaultPolicy()
	NormalizeStoredPolicy(p)
	for _, kr := range keriRoles {
		bundle := MapKERIRole(kr)
		for _, action := range legacyActions {
			if reHomedSinceLegacy[action] {
				continue // #318 deliberately re-homes save_org_config; see policy_test.go
			}
			legacy := legacyCan(bundle, action)
			viaPolicy := CanPerformActionWithPolicy(p, bundle, action)
			if legacy != viaPolicy {
				t.Errorf("divergence after migration: keriRole=%q action=%q legacy=%v policy=%v",
					kr, action, legacy, viaPolicy)
			}
		}
	}
	// After migration a legacy saved policy must also enforce the #318 re-homing:
	// the founder gains manage_community_settings (new-capability default merge)
	// and can save org config; the operations steward, which held manage_members
	// but never the new capability, is refused.
	if !CanPerformActionWithPolicy(p, MapKERIRole("Founding Member"), ActionSaveOrgConfig) {
		t.Error("migrated policy: Founding Member must be able to save org config")
	}
	if CanPerformActionWithPolicy(p, MapKERIRole("Operations Steward"), ActionSaveOrgConfig) {
		t.Error("migrated policy: Operations Steward must NOT save org config after the #318 re-homing")
	}
}

// Idempotence: normalizing an already-migrated policy changes nothing.
func TestNormalizeStoredPolicyIdempotent(t *testing.T) {
	p := legacyDefaultPolicy()
	NormalizeStoredPolicy(p)
	before := map[string]int{}
	for id, caps := range p.Grants {
		before[id] = len(caps)
	}
	NormalizeStoredPolicy(p)
	for id, caps := range p.Grants {
		if before[id] != len(caps) {
			t.Errorf("role %s grant count changed on second normalize: %d → %d", id, before[id], len(caps))
		}
	}
}
