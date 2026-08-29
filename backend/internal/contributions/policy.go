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
}

// RoleGrants returns the capabilities granted to a role ID (nil if unknown).
func (p *RolePolicy) RoleGrants(roleID string) []Capability {
	return p.Grants[roleID]
}

// HasCapability reports whether any of userRoles holds cap under this policy.
func (p *RolePolicy) HasCapability(userRoles []Role, cap Capability) bool {
	for _, r := range userRoles {
		for _, c := range p.Grants[string(r)] {
			if c == cap {
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
	cap, ok := ActionCapability(action)
	if !ok {
		return false
	}
	return p.HasCapability(userRoles, cap)
}

// baseCaps are granted to every builtin role — they cover exactly the
// actions the legacy table marks allRoles. CapAssignWork is stewardScope.
var baseCaps = []Capability{CapContribute, CapManageProjects, CapReviewWork}

// DefaultRolePolicy returns the built-in policy, exactly equivalent to the
// legacy actionPermissions table (proven by TestDefaultPolicyEquivalentToLegacyTable).
// It is used whenever no RolePolicy object is synced, and as the base for a
// community's first edit.
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

	grants := map[string][]Capability{
		string(RoleMember):      append([]Capability{}, baseCaps...),
		string(RoleContributor): append([]Capability{}, baseCaps...),
		string(RoleProjectLead): append(append([]Capability{}, baseCaps...),
			CapSubmitCompletion, CapArchiveWork),
		// project_steward is a project-scoped role, so it holds only
		// project-scoped capabilities. Proposal governance (manage_governance)
		// is reproduced via the community roles it always co-occurs with in
		// every KERI bundle (community/operations steward, founding member),
		// so dropping it here keeps TestDefaultPolicyEquivalentToLegacyTable.
		string(RoleProjectSteward): append(append([]Capability{}, baseCaps...),
			CapAssignWork, CapSignOff, CapApproveCompletion, CapArchiveWork),
		string(RoleOperationsSteward): append(append([]Capability{}, baseCaps...),
			CapAssignWork, CapSignOff, CapReward, CapSubmitCompletion, CapApproveCompletion,
			CapArchiveWork, CapManageMembers, CapManageGovernance, CapManageComms, CapManageRoles),
		string(RoleCommunitySteward): append(append([]Capability{}, baseCaps...),
			CapManageGovernance, CapManageComms),
		string(RoleFoundingMember): append(append([]Capability{}, baseCaps...),
			CapAssignWork, CapSignOff, CapReward, CapSubmitCompletion, CapApproveCompletion,
			CapArchiveWork, CapManageMembers, CapManageGovernance, CapManageComms, CapManageRoles),
	}

	return &RolePolicy{Version: 0, Roles: roles, Grants: grants}
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
