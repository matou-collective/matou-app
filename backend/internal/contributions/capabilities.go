// backend/internal/contributions/capabilities.go
package contributions

// Capability is a human-sized group of Actions, the unit admins toggle in the
// Roles & Permissions UI. The registry below is fixed in code; the synced
// RolePolicy stores only which roles hold which capabilities.
type Capability string

const (
	CapContribute        Capability = "contribute"
	CapManageProjects    Capability = "manage_projects"
	CapReviewWork        Capability = "review_work"
	CapSignOff           Capability = "sign_off"
	CapReward            Capability = "reward"
	CapSubmitCompletion  Capability = "submit_completion"
	CapApproveCompletion Capability = "approve_completion"
	CapArchiveWork       Capability = "archive_work"
	CapManageMembers     Capability = "manage_members"
	CapManageGovernance  Capability = "manage_governance"
	CapManageRoles       Capability = "manage_roles"

	// Feature-scoped capabilities added by the #312 umbrella. The three
	// project-scoped ones (view_contribution_amounts, assign_project_steward,
	// assign_project_lead) may be held by a project role; the rest are
	// community-scoped.
	CapViewContributionAmounts Capability = "view_contribution_amounts"
	CapAssignProjectSteward    Capability = "assign_project_steward"
	CapAssignProjectLead       Capability = "assign_project_lead"
	CapCreateProposals         Capability = "create_proposals"
	CapSendMessages            Capability = "send_messages"
	CapManageChannels          Capability = "manage_channels"
	CapModerateMessages        Capability = "moderate_messages"
	CapPostNotices             Capability = "post_notices"
	CapManageNotices           Capability = "manage_notices"
	CapOpenCommunitySettings   Capability = "open_community_settings"
	CapManageCommunitySettings Capability = "manage_community_settings"

	// Retired capabilities (#313). These IDs are no longer toggleable and are
	// absent from AllCapabilities()/the default policy, but the constants
	// survive as the source of the migration mapping applied on policy read
	// (NormalizeStoredPolicy) and as the IDs the PUT handler rejects. assign_work
	// maps to the two assign capabilities; manage_communications to the two chat
	// moderation capabilities.
	CapAssignWork  Capability = "assign_work"
	CapManageComms Capability = "manage_communications"
)

// Feature-table group labels — the UI renders one permission table per group
// (#312). Capability metadata carries the group so the front-end need not
// hard-code the mapping.
const (
	GroupProjects  = "Projects & Contributions"
	GroupProposals = "Proposals"
	GroupChat      = "Chat"
	GroupNotices   = "Notices"
	GroupCommunity = "Community"
)

// CurrentCapModel is the capability-registry version. A saved policy stamps the
// model it was written under; a policy read at an older model has the defaults
// of any newer capability merged in (see NormalizeStoredPolicy) so a new column
// never starts dark. Bump this whenever capabilities are added/retired and give
// the new entries Introduced == the new CurrentCapModel.
const CurrentCapModel = 1

// CapabilityMeta is the display/grouping/scope metadata for one capability,
// exposed to the UI via GET /api/v1/role-policy. Introduced is the CapModel at
// which the capability entered the registry (0 = original set).
type CapabilityMeta struct {
	ID          Capability `json:"id"`
	DisplayName string     `json:"displayName"`
	Group       string     `json:"group"`
	Scope       string     `json:"scope"`
	Introduced  int        `json:"-"`
}

// allCapabilityMeta is the single ordered source of truth for the toggleable
// capabilities: their display order (matching the feature tables), display
// name, feature-table group, scope, and the model they were introduced at.
// Retired capabilities are intentionally absent.
var allCapabilityMeta = []CapabilityMeta{
	// Projects & Contributions
	{CapContribute, "Contribute", GroupProjects, ScopeProject, 0},
	{CapManageProjects, "Manage Projects", GroupProjects, ScopeProject, 0},
	{CapReviewWork, "Review Work", GroupProjects, ScopeProject, 0},
	{CapSignOff, "Sign Off", GroupProjects, ScopeProject, 0},
	{CapReward, "Reward", GroupProjects, ScopeCommunity, 0},
	{CapSubmitCompletion, "Submit Completion", GroupProjects, ScopeProject, 0},
	{CapApproveCompletion, "Approve Completion", GroupProjects, ScopeProject, 0},
	{CapArchiveWork, "Archive Work", GroupProjects, ScopeProject, 0},
	{CapViewContributionAmounts, "View Contribution Amounts", GroupProjects, ScopeProject, 1},
	{CapAssignProjectSteward, "Assign Project Steward", GroupProjects, ScopeProject, 1},
	{CapAssignProjectLead, "Assign Project Lead", GroupProjects, ScopeProject, 1},
	// Proposals
	{CapCreateProposals, "Create Proposals", GroupProposals, ScopeCommunity, 1},
	{CapManageGovernance, "Manage Governance", GroupProposals, ScopeCommunity, 0},
	// Chat
	{CapSendMessages, "Send Messages", GroupChat, ScopeCommunity, 1},
	{CapManageChannels, "Manage Channels", GroupChat, ScopeCommunity, 1},
	{CapModerateMessages, "Moderate Messages", GroupChat, ScopeCommunity, 1},
	// Notices
	{CapPostNotices, "Post Notices", GroupNotices, ScopeCommunity, 1},
	{CapManageNotices, "Manage Notices", GroupNotices, ScopeCommunity, 1},
	// Community
	{CapOpenCommunitySettings, "Open Community Settings", GroupCommunity, ScopeCommunity, 1},
	{CapManageCommunitySettings, "Manage Community Settings", GroupCommunity, ScopeCommunity, 1},
	{CapManageMembers, "Manage Members", GroupCommunity, ScopeCommunity, 0},
	{CapManageRoles, "Manage Roles", GroupCommunity, ScopeCommunity, 0},
}

// capabilityMeta indexes allCapabilityMeta by ID.
var capabilityMeta = func() map[Capability]CapabilityMeta {
	m := make(map[Capability]CapabilityMeta, len(allCapabilityMeta))
	for _, meta := range allCapabilityMeta {
		m[meta.ID] = meta
	}
	return m
}()

// retiredSuccessors maps each retired capability to the capabilities that
// inherit its grants when a saved policy is normalized on read (#313). A grant
// of the retired ID becomes grants of every successor; the retired ID is then
// dropped. The successors are ALSO excluded from the new-capability default
// merge (see NormalizeStoredPolicy) so that a legacy grant the admin had
// REMOVED is not silently resurrected by the merge.
var retiredSuccessors = map[Capability][]Capability{
	CapAssignWork:  {CapAssignProjectSteward, CapAssignProjectLead},
	CapManageComms: {CapManageChannels, CapModerateMessages},
}

// isRetirementSuccessor is the set of capabilities that only ever gain grants
// via the retirement mapping, never via the default merge.
var isRetirementSuccessor = func() map[Capability]bool {
	m := map[Capability]bool{}
	for _, succs := range retiredSuccessors {
		for _, s := range succs {
			m[s] = true
		}
	}
	return m
}()

// IsRetiredCapability reports whether a capability ID has been retired and may
// no longer be stored by a PUT.
func IsRetiredCapability(c Capability) bool {
	_, ok := retiredSuccessors[c]
	return ok
}

// RetiredCapabilitySuccessors returns the capabilities that replaced a retired
// capability (nil if it is not retired).
func RetiredCapabilitySuccessors(c Capability) []Capability {
	succs, ok := retiredSuccessors[c]
	if !ok {
		return nil
	}
	return append([]Capability(nil), succs...)
}

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
	// assign_project_steward inherits the steward-tier actions of retired
	// assign_work: the coarse assign-project-role route (still wired here; its
	// split into the two granular endpoints is enforcement work for a later
	// slice) and initialising a newly approved member's profile. Keeping
	// init_member_profile here (rather than moving it under manage_members as
	// #312 ultimately wants) preserves today's enforcement exactly — a move to
	// manage_members would strip project_steward of it, an enforcement change
	// #313 forbids. Deferred to the members enforcement slice.
	CapAssignProjectSteward: {ActionAssignProjectRole, ActionAssignProjectSteward, ActionInitMemberProfile},
	CapAssignProjectLead:    {ActionAssignProjectLead},
	CapReviewWork:           {ActionReviewContribution, ActionApproveSubContrib},
	CapSignOff:              {ActionSignOffContribution, ActionSignOffPlan},
	CapReward:               {ActionRewardContribution},
	CapSubmitCompletion:     {ActionSubmitProjectCompletion},
	CapApproveCompletion:    {ActionApproveProjectCompletion, ActionRejectProjectCompletion},
	// leadStewardScope: plan lifecycle (archive, unassign, milestone edits,
	// linking a proposal to a project).
	CapArchiveWork: {
		ActionArchiveProject, ActionArchiveMilestone, ActionArchiveContribution,
		ActionUnassignContribution, ActionEditMilestone, ActionLinkProposal,
	},
	// adminScope: member roles plus the role-granting bootstrap routes.
	// save_org_config stays here for now; #312 moves it under
	// manage_community_settings, but that re-homing changes enforcement (a
	// founder-only default drops operations_steward, and a partial move risks
	// resurrecting a removed grant), so it is deferred to the community-settings
	// enforcement slice.
	CapManageMembers: {
		ActionChangeMemberRole, ActionRemoveMember,
		ActionSaveOrgConfig, ActionGrantStewardAdmin, ActionSetIdentity,
	},
	CapManageGovernance: {ActionSignOffProposal, ActionRejectProposal, ActionEditProposal, ActionWithdrawProposal},
	CapManageRoles:      {ActionManageRolePolicy},

	// New feature capabilities that gate no wired action yet — the grants can be
	// configured ahead of the enforcement slices that wire them (chat, notices,
	// proposal-create, contribution-amount visibility, community settings).
	CapViewContributionAmounts: {},
	CapCreateProposals:         {},
	CapSendMessages:            {},
	CapManageChannels:          {},
	CapModerateMessages:        {},
	CapPostNotices:             {},
	CapManageNotices:           {},
	CapOpenCommunitySettings:   {},
	CapManageCommunitySettings: {},
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

// AllCapabilities returns every toggleable capability in stable display order
// (matching the feature tables). Retired capabilities are excluded.
func AllCapabilities() []Capability {
	out := make([]Capability, 0, len(allCapabilityMeta))
	for _, meta := range allCapabilityMeta {
		out = append(out, meta.ID)
	}
	return out
}

// CapabilityMetadata returns the display/group/scope metadata for every
// toggleable capability, in display order — the UI uses it to lay out the
// feature tables.
func CapabilityMetadata() []CapabilityMeta {
	out := make([]CapabilityMeta, len(allCapabilityMeta))
	copy(out, allCapabilityMeta)
	return out
}

// IsProjectScopedCapability reports whether a capability may be held by a
// project-scoped role.
func IsProjectScopedCapability(c Capability) bool {
	meta, ok := capabilityMeta[c]
	return ok && meta.Scope == ScopeProject
}

// ProjectScopedCapabilities returns the project-scoped capabilities in
// AllCapabilities() display order.
func ProjectScopedCapabilities() []Capability {
	out := make([]Capability, 0, len(allCapabilityMeta))
	for _, meta := range allCapabilityMeta {
		if meta.Scope == ScopeProject {
			out = append(out, meta.ID)
		}
	}
	return out
}
