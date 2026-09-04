package contributions

// perProjectRoles are the contribution-system roles that are meaningful only on
// a SPECIFIC project. They are granted by per-project assignment — the project
// lead/steward set on the project (assign-role), or being the assigned
// contributor on a contribution in that project — never by a community-wide
// credential. See docs/RBAC.md ("Project-scoped role resolution").
var perProjectRoles = []Role{RoleProjectLead, RoleProjectSteward, RoleContributor}

// IsProjectRole reports whether r is a per-project assignment role rather than a
// community-wide role.
func IsProjectRole(r Role) bool {
	return HasRole(perProjectRoles, r)
}

// projectScopedActions are the actions whose authorisation depends on the
// caller's role ON THE TARGET PROJECT, not on their community-wide roles. For
// these, RBAC evaluates communityRoles(with per-project roles stripped) ∪
// projectRoles(project) against the policy. Every other action is
// community-scoped and evaluated against the community roles alone.
//
// Only lead/steward-tier actions appear here: actions the default policy already
// grants to plain members (contribute, manage-projects, review-work) gain
// nothing from project scoping — a member survives the strip-and-reunion — so
// they stay community-scoped and are gated at the resource level (e.g. evidence
// ownership) as before.
var projectScopedActions = map[Action]bool{
	ActionSignOffContribution:      true,
	ActionSignOffPlan:              true,
	ActionSubmitProjectCompletion:  true,
	ActionApproveProjectCompletion: true,
	ActionRejectProjectCompletion:  true,
	ActionArchiveProject:           true,
	ActionArchiveMilestone:         true,
	ActionArchiveContribution:      true,
	ActionUnassignContribution:     true,
	ActionEditMilestone:            true,
	ActionLinkProposal:             true,
	ActionAssignProjectRole:        true,
	ActionAssignProjectSteward:     true,
	ActionAssignProjectLead:        true,
}

// IsProjectScopedAction reports whether action is authorised against the
// caller's role on a specific project rather than community-globally.
func IsProjectScopedAction(a Action) bool {
	return projectScopedActions[a]
}

// StripProjectRoles returns roles with every per-project role removed. It builds
// the community-role baseline for a project-scoped check: a project role only
// counts when it comes from an actual assignment on the target project, never
// from a community credential bundle (MapKERIRole may map e.g. Community Steward
// → project_steward or Technical Steward → project_lead, but those must not make
// the holder lead/steward of EVERY project). See docs/RBAC.md.
func StripProjectRoles(roles []Role) []Role {
	out := make([]Role, 0, len(roles))
	for _, r := range roles {
		if !IsProjectRole(r) {
			out = append(out, r)
		}
	}
	return out
}

// ProjectScopedRoles combines the caller's community roles (with per-project
// roles stripped) with the roles they actually hold on the target project.
// Community-scope grants (e.g. an Operations Steward's operations_steward role)
// survive and keep working on every project; credential-derived project roles do
// not.
func ProjectScopedRoles(communityRoles, projectRoles []Role) []Role {
	base := StripProjectRoles(communityRoles)
	return append(base, projectRoles...)
}

// CanPerformProjectAction evaluates a project-scoped action against the union of
// the caller's community roles (per-project roles stripped) and the roles they
// hold on the target project, under the community's current RolePolicy.
func CanPerformProjectAction(communityRoles, projectRoles []Role, action Action) bool {
	return CanPerformAction(ProjectScopedRoles(communityRoles, projectRoles), action)
}
