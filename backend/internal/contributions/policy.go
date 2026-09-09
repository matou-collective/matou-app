package contributions

// Role scope constants. A community role ("who you are", issued as a
// membership credential) may hold any capability; a project role ("what you
// hold on one project", assigned per project) may hold only project-scoped
// capabilities (see ProjectScopedCapabilities). The Roles & Permissions page
// renders one table per scope (issue #165).
const (
	ScopeCommunity = "community"
	ScopeProject   = "project"
)

// RoleDef is one entry in the RolePolicy role registry. Builtin roles are the
// contribution-system roles that ship with the app and cannot be deleted,
// renamed, or re-scoped; custom roles are admin-created. A RoleDef's ID
// doubles as the membership-credential role string for custom roles. Scope is
// "community" or "project"; an empty scope on a legacy synced policy is
// treated as "community" (see NormalizeScope).
type RoleDef struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Builtin     bool   `json:"builtin"`
	Scope       string `json:"scope"`
}

// RolePolicy is the community's editable RBAC policy: which roles exist and
// which capabilities each holds. One versioned object per community, synced
// via the community-readonly space (object type "RolePolicy", object ID
// "RolePolicy" — a singleton). Version 0 means "built-in default, never saved".
type RolePolicy struct {
	Version   int                     `json:"version"`
	UpdatedBy string                  `json:"updatedBy,omitempty"`
	UpdatedAt string                  `json:"updatedAt,omitempty"`
	Roles     []RoleDef               `json:"roles"`
	Grants    map[string][]Capability `json:"grants"`
	// CapModel is the capability-registry version this policy was saved under
	// (CurrentCapModel). Absent (0) on any policy predating the field. On read,
	// NormalizeStoredPolicy merges the defaults of every capability newer than
	// this value so a new column never starts dark; the PUT handler stamps
	// CurrentCapModel on save.
	CapModel int `json:"capModel,omitempty"`
}

// RoleGrants returns the capabilities granted to a role ID (nil if unknown).
func (p *RolePolicy) RoleGrants(roleID string) []Capability {
	return p.Grants[roleID]
}

// HasCapability reports whether any of userRoles holds capVal under this policy.
func (p *RolePolicy) HasCapability(userRoles []Role, capVal Capability) bool {
	for _, r := range userRoles {
		for _, c := range p.Grants[string(r)] {
			if c == capVal {
				return true
			}
		}
	}
	return false
}

// HasCustomRole reports whether roleID is a non-builtin role in the registry.
func (p *RolePolicy) HasCustomRole(roleID string) bool {
	for _, r := range p.Roles {
		if r.ID == roleID && !r.Builtin {
			return true
		}
	}
	return false
}

// CanPerformActionWithPolicy is the pure policy check: action → capability →
// grants. Unknown actions are always denied.
func CanPerformActionWithPolicy(p *RolePolicy, userRoles []Role, action Action) bool {
	capVal, ok := ActionCapability(action)
	if !ok {
		return false
	}
	return p.HasCapability(userRoles, capVal)
}

// baseCaps are granted to every builtin role — they cover exactly the
// actions the legacy table marks allRoles.
var baseCaps = []Capability{CapContribute, CapManageProjects, CapReviewWork}

// communityMemberCaps are the community-scoped feature capabilities every
// community role holds by default (#312): creating proposals, sending chat
// messages, and posting notices. They are NOT part of baseCaps because baseCaps
// is granted to project roles too, and a project role may not hold a
// community-scoped capability.
var communityMemberCaps = []Capability{CapCreateProposals, CapSendMessages, CapPostNotices}

// DefaultRolePolicy returns the built-in policy. For every action in the legacy
// actionPermissions table it reproduces today's behaviour exactly (proven by
// TestDefaultPolicyEquivalentToLegacyTable); the #312 capabilities that gate no
// wired action yet carry the umbrella's default grants. It is used whenever no
// RolePolicy object is synced, and as the base for a community's first edit.
func DefaultRolePolicy() *RolePolicy {
	roles := []RoleDef{
		{ID: string(RoleMember), DisplayName: "Member", Builtin: true, Scope: ScopeCommunity},
		{ID: string(RoleContributor), DisplayName: "Contributor", Builtin: true, Scope: ScopeProject},
		{ID: string(RoleProjectLead), DisplayName: "Project Lead", Builtin: true, Scope: ScopeProject},
		{ID: string(RoleProjectSteward), DisplayName: "Project Steward", Builtin: true, Scope: ScopeProject},
		{ID: string(RoleOperationsSteward), DisplayName: "Operations Steward", Builtin: true, Scope: ScopeCommunity},
		{ID: string(RoleCommunitySteward), DisplayName: "Community Steward", Builtin: true, Scope: ScopeCommunity},
		{ID: string(RoleFoundingMember), DisplayName: "Founding Member", Builtin: true, Scope: ScopeCommunity},
	}

	// stewardCommsCaps: the chat/notice moderation defaults for stewards+founder
	// (#312). manage_channels/moderate_messages are also the successors of the
	// retired manage_communications, whose legacy default holders were exactly
	// these community roles — so the fresh default and the migration mapping
	// agree.
	stewardCommsCaps := []Capability{CapManageChannels, CapModerateMessages, CapManageNotices}

	grants := map[string][]Capability{
		string(RoleMember): concatCaps(baseCaps, communityMemberCaps),
		// contributor is project-scoped: only base (project) caps by default; the
		// new community feature caps cannot be held by a project role.
		string(RoleContributor): concatCaps(baseCaps),
		string(RoleProjectLead): concatCaps(baseCaps,
			[]Capability{CapSubmitCompletion, CapArchiveWork, CapViewContributionAmounts}),
		// project_steward keeps manage_governance even though it is
		// project-scoped: the #165 split is UI + policy model only, and the
		// default policy must reproduce today's grants exactly. Whether a
		// project-scoped steward should lose community governance is an
		// enforcement question deferred to #166. The PUT validation
		// grandfathers this grant (removable, not re-addable). assign_work is
		// retired: its steward-tier authority is now the two assign capabilities.
		string(RoleProjectSteward): concatCaps(baseCaps,
			[]Capability{CapAssignProjectSteward, CapAssignProjectLead, CapSignOff,
				CapApproveCompletion, CapArchiveWork, CapManageGovernance, CapViewContributionAmounts}),
		string(RoleOperationsSteward): concatCaps(baseCaps, communityMemberCaps, stewardCommsCaps,
			[]Capability{CapAssignProjectSteward, CapAssignProjectLead, CapSignOff, CapReward,
				CapSubmitCompletion, CapApproveCompletion, CapArchiveWork, CapManageMembers,
				CapManageGovernance, CapManageRoles}),
		string(RoleCommunitySteward): concatCaps(baseCaps, communityMemberCaps, stewardCommsCaps,
			[]Capability{CapManageGovernance}),
		string(RoleFoundingMember): concatCaps(baseCaps, communityMemberCaps, stewardCommsCaps,
			[]Capability{CapAssignProjectSteward, CapAssignProjectLead, CapSignOff, CapReward,
				CapSubmitCompletion, CapApproveCompletion, CapArchiveWork, CapManageMembers,
				CapManageGovernance, CapManageRoles,
				// Founder-only community-settings capabilities (#312).
				CapOpenCommunitySettings, CapManageCommunitySettings}),
	}

	return &RolePolicy{Version: 0, CapModel: CurrentCapModel, Roles: roles, Grants: grants}
}

// concatCaps returns a fresh slice concatenating the given capability groups.
// Each DefaultRolePolicy grant is a new slice so callers may mutate it freely.
func concatCaps(groups ...[]Capability) []Capability {
	out := []Capability{}
	for _, g := range groups {
		out = append(out, g...)
	}
	return out
}

// builtinScopes maps each builtin role ID to its canonical scope. Built once
// from the default policy so there is a single source of truth.
var builtinScopes = func() map[string]string {
	m := map[string]string{}
	for _, r := range DefaultRolePolicy().Roles {
		m[r.ID] = r.Scope
	}
	return m
}()

// BuiltinRoleScope returns the canonical scope of a builtin role and whether
// the ID names a builtin role.
func BuiltinRoleScope(id string) (string, bool) {
	s, ok := builtinScopes[id]
	return s, ok
}

// NormalizeScope returns a role's effective scope: a builtin's canonical scope
// always wins (it cannot be re-scoped), and an empty custom scope — as found on
// a legacy synced policy written before the community/project split — defaults
// to community.
func NormalizeScope(id, scope string) string {
	if canonical, ok := BuiltinRoleScope(id); ok {
		return canonical
	}
	if scope == ScopeProject {
		return ScopeProject
	}
	return ScopeCommunity
}

// NormalizeScopes rewrites every role's Scope in place to its effective scope.
// Applied on read so the UI always sees correct scopes even for a legacy
// policy that predates the field, and on write so builtins keep their scope.
func (p *RolePolicy) NormalizeScopes() {
	for i := range p.Roles {
		p.Roles[i].Scope = NormalizeScope(p.Roles[i].ID, p.Roles[i].Scope)
	}
}

// NormalizeStoredPolicy upgrades a policy read from the store in place so the
// running registry can enforce and render it (#313). It is idempotent and
// applied on every read (StorePolicyProvider) before the policy reaches
// enforcement, the GET handler, or the PUT version check. The Version is left
// untouched; the migrated grants are persisted the next time the policy is
// saved. Three steps, in order:
//
//  1. Retirement mapping — a grant of a retired capability (assign_work,
//     manage_communications) becomes grants of its successors, and the retired
//     ID is dropped. So a role that could assign project roles / initialise
//     profiles keeps that authority under the successor capabilities.
//  2. Default merge (the upgrade path) — for each builtin role, any capability
//     newer than the policy's saved CapModel is granted per the default policy,
//     so a new column never starts dark for a community with a saved policy.
//     Retirement successors are excluded here: their grants are decided solely
//     by step 1, so a legacy grant the admin had removed is never resurrected.
//  3. Stamp — CapModel is advanced to CurrentCapModel in memory so callers see
//     an up-to-date policy; the value is only durably persisted on next save.
//
// It composes with the #201 grandfather logic: the default merge only ever adds
// a capability to a role the default policy already grants it, which never
// introduces a community-only capability onto a project role beyond the ones
// the default already grandfathers.
func NormalizeStoredPolicy(p *RolePolicy) {
	if p == nil {
		return
	}
	if p.CapModel >= CurrentCapModel && !storedPolicyHasRetiredGrant(p) {
		return // already current, nothing to migrate
	}
	expandRetiredGrants(p)
	mergeNewCapabilityDefaults(p)
	p.CapModel = CurrentCapModel
}

// storedPolicyHasRetiredGrant reports whether any role still holds a retired
// capability ID — a policy saved at CurrentCapModel should not, but a
// hand-written or corrupt object might, and the retirement mapping must still
// run for it.
func storedPolicyHasRetiredGrant(p *RolePolicy) bool {
	for _, caps := range p.Grants {
		for _, c := range caps {
			if IsRetiredCapability(c) {
				return true
			}
		}
	}
	return false
}

// expandRetiredGrants rewrites each role's grants, replacing a retired
// capability with its successors and dropping the retired ID, de-duplicating
// the result while preserving order.
func expandRetiredGrants(p *RolePolicy) {
	for roleID, caps := range p.Grants {
		out := make([]Capability, 0, len(caps))
		seen := map[Capability]bool{}
		add := func(c Capability) {
			if !seen[c] {
				seen[c] = true
				out = append(out, c)
			}
		}
		for _, c := range caps {
			if succs, retired := retiredSuccessors[c]; retired {
				for _, s := range succs {
					add(s)
				}
				continue
			}
			add(c)
		}
		p.Grants[roleID] = out
	}
}

// mergeNewCapabilityDefaults grants each builtin role the default-policy grants
// of any capability introduced after the policy's CapModel, skipping retirement
// successors (handled by expandRetiredGrants) and capabilities the role already
// holds.
func mergeNewCapabilityDefaults(p *RolePolicy) {
	def := DefaultRolePolicy()
	held := map[string]map[Capability]bool{}
	for roleID, caps := range p.Grants {
		m := map[Capability]bool{}
		for _, c := range caps {
			m[c] = true
		}
		held[roleID] = m
	}
	for _, role := range def.Roles {
		for _, c := range def.Grants[role.ID] {
			meta, ok := capabilityMeta[c]
			if !ok || meta.Introduced <= p.CapModel {
				continue // original capability, or unknown — not new to this policy
			}
			if isRetirementSuccessor[c] {
				continue // decided by the retirement mapping, never resurrected here
			}
			if held[role.ID] == nil {
				held[role.ID] = map[Capability]bool{}
			}
			if held[role.ID][c] {
				continue
			}
			held[role.ID][c] = true
			p.Grants[role.ID] = append(p.Grants[role.ID], c)
		}
	}
}
