// backend/internal/contributions/capabilities.go
package contributions

// Capability is a human-sized group of Actions, the unit admins toggle in the
// Roles & Permissions UI. The registry below is fixed in code; the synced
// RolePolicy stores only which roles hold which capabilities.
type Capability string

const (
	CapContribute        Capability = "contribute"
	CapManageProjects    Capability = "manage_projects"
	CapAssignWork        Capability = "assign_work"
	CapReviewWork        Capability = "review_work"
	CapSignOff           Capability = "sign_off"
	CapReward            Capability = "reward"
	CapSubmitCompletion  Capability = "submit_completion"
	CapApproveCompletion Capability = "approve_completion"
	CapArchiveWork       Capability = "archive_work"
	CapManageMembers     Capability = "manage_members"
	CapManageGovernance  Capability = "manage_governance"
	CapManageComms       Capability = "manage_communications"
	CapManageRoles       Capability = "manage_roles"
)

// capabilityActions is the single place a backend Action gets classified.
// Composition mirrors the permission equivalence classes of the legacy
// actionPermissions table so the default policy (policy.go) reproduces
// today's behavior exactly.
var capabilityActions = map[Capability][]Action{
	// Everything the legacy table grants to allRoles: authenticated-member
	// actions whose real access rules are resource-level (owner / assignee /
	// steward checks in the service and handler layers).
	CapContribute: {
		ActionCreateContribution, ActionConfirmContribution, ActionRegisterInterest,
		ActionShareContribution, ActionOfferContribution, ActionAcceptOffer,
		ActionSubmitEvidence, ActionEditEvidence, ActionAssignContribution,
		ActionTransitionContribution, ActionUpdateContribution,
		ActionStoreCredential, ActionWriteProfile,
	},
	CapManageProjects: {ActionCreateProject, ActionEditProject, ActionDeleteProject},
	// stewardScope: hand out project lead/steward roles and initialise a
	// newly approved member's profile.
	CapAssignWork:        {ActionAssignProjectRole, ActionInitMemberProfile},
	CapReviewWork:        {ActionReviewContribution, ActionApproveSubContrib},
	CapSignOff:           {ActionSignOffContribution, ActionSignOffPlan},
	CapReward:            {ActionRewardContribution},
	CapSubmitCompletion:  {ActionSubmitProjectCompletion},
	CapApproveCompletion: {ActionApproveProjectCompletion, ActionRejectProjectCompletion},
	// leadStewardScope: plan lifecycle (archive, unassign, milestone edits,
	// linking a proposal to a project).
	CapArchiveWork: {
		ActionArchiveProject, ActionArchiveMilestone, ActionArchiveContribution,
		ActionUnassignContribution, ActionEditMilestone, ActionLinkProposal,
	},
	// adminScope: member roles plus the role-granting bootstrap routes.
	CapManageMembers: {
		ActionChangeMemberRole, ActionRemoveMember,
		ActionSaveOrgConfig, ActionGrantStewardAdmin, ActionSetIdentity,
	},
	CapManageGovernance: {ActionSignOffProposal, ActionRejectProposal, ActionEditProposal, ActionWithdrawProposal},
	// Notices/chat routes have no Action constants yet (follow-up to issue #6).
	// The capability exists so grants can be configured ahead of enforcement.
	CapManageComms: {},
	CapManageRoles: {ActionManageRolePolicy},
}

// actionToCapability is the reverse index, built once at init.
var actionToCapability = func() map[Action]Capability {
	m := make(map[Action]Capability)
	for cap, actions := range capabilityActions {
		for _, a := range actions {
			m[a] = cap
		}
	}
	return m
}()

// CapabilityActions returns the full capability → actions registry.
func CapabilityActions() map[Capability][]Action {
	return capabilityActions
}

// ActionCapability returns the capability an action belongs to.
func ActionCapability(a Action) (Capability, bool) {
	cap, ok := actionToCapability[a]
	return cap, ok
}

// AllCapabilities returns every capability in stable display order.
func AllCapabilities() []Capability {
	return []Capability{
		CapContribute, CapManageProjects, CapAssignWork, CapReviewWork,
		CapSignOff, CapReward, CapSubmitCompletion, CapApproveCompletion,
		CapArchiveWork, CapManageMembers, CapManageGovernance, CapManageComms,
		CapManageRoles,
	}
}

// projectScopedCaps is the set of capabilities a project-scoped role may hold.
// A project role ("what you hold on one project" — project_lead,
// project_steward, contributor, custom project roles) is limited to these; a
// community role ("who you are") may hold any capability. This mirrors the
// column set the Roles & Permissions project table exposes (issue #165). It
// covers the per-project workflow — contributing evidence, managing/assigning/
// reviewing work, signing off, submitting/approving completion, archiving —
// but not the community-wide capabilities (reward, manage_members,
// manage_governance, manage_communications, manage_roles).
var projectScopedCaps = map[Capability]bool{
	CapContribute:        true,
	CapManageProjects:    true,
	CapAssignWork:        true,
	CapReviewWork:        true,
	CapSignOff:           true,
	CapSubmitCompletion:  true,
	CapApproveCompletion: true,
	CapArchiveWork:       true,
}

// IsProjectScopedCapability reports whether a capability may be held by a
// project-scoped role.
func IsProjectScopedCapability(c Capability) bool {
	return projectScopedCaps[c]
}

// ProjectScopedCapabilities returns the project-scoped capabilities in
// AllCapabilities() display order.
func ProjectScopedCapabilities() []Capability {
	out := make([]Capability, 0, len(projectScopedCaps))
	for _, c := range AllCapabilities() {
		if projectScopedCaps[c] {
			out = append(out, c)
		}
	}
	return out
}
