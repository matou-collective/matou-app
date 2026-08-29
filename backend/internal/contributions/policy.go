package contributions

// RoleDef is one entry in the RolePolicy role registry. Builtin roles are the
// 10 contribution-system roles that ship with the app and cannot be deleted
// or renamed; custom roles are admin-created. A RoleDef's ID doubles as the
// membership-credential role string for custom roles.
type RoleDef struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Builtin     bool   `json:"builtin"`
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
		{ID: string(RoleMember), DisplayName: "Member", Builtin: true},
		{ID: string(RoleContributor), DisplayName: "Contributor", Builtin: true},
		{ID: string(RoleProjectLead), DisplayName: "Project Lead", Builtin: true},
		{ID: string(RoleProjectSteward), DisplayName: "Project Steward", Builtin: true},
		{ID: string(RoleOperationsSteward), DisplayName: "Operations Steward", Builtin: true},
		{ID: string(RoleCommunitySteward), DisplayName: "Community Steward", Builtin: true},
		{ID: string(RoleFoundingMember), DisplayName: "Founding Member", Builtin: true},
	}

	grants := map[string][]Capability{
		string(RoleMember):      append([]Capability{}, baseCaps...),
		string(RoleContributor): append([]Capability{}, baseCaps...),
		string(RoleProjectLead): append(append([]Capability{}, baseCaps...),
			CapSubmitCompletion, CapArchiveWork),
		string(RoleProjectSteward): append(append([]Capability{}, baseCaps...),
			CapAssignWork, CapSignOff, CapApproveCompletion, CapArchiveWork, CapManageGovernance),
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
