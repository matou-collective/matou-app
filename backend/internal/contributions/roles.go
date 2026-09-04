// backend/internal/contributions/roles.go
package contributions

// Role represents a contribution-specific role.
// These are internal to the contributions system and mapped FROM existing KERI roles.
type Role string

const (
	RoleMember            Role = "member"
	RoleContributor       Role = "contributor"
	RoleProjectLead       Role = "project_lead"
	RoleProjectSteward    Role = "project_steward"
	RoleOperationsSteward Role = "operations_steward"
	RoleCommunitySteward  Role = "community_steward"
	RoleFoundingMember    Role = "founding_member"
)

// MapKERIRole maps a KERI credential role string (Title Case) to contribution roles.
// A single KERI role may grant multiple contribution roles (e.g. stewards also get project_steward).
func MapKERIRole(keriRole string) []Role {
	switch keriRole {
	case "Member":
		return []Role{RoleMember}
	case "Contributor":
		return []Role{RoleMember, RoleContributor}
	case "Community Steward":
		return []Role{RoleMember, RoleContributor, RoleCommunitySteward, RoleProjectSteward}
	case "Operations Steward":
		return []Role{RoleMember, RoleContributor, RoleOperationsSteward, RoleProjectSteward, RoleProjectLead}
	case "Founding Member":
		return []Role{RoleMember, RoleContributor, RoleFoundingMember, RoleOperationsSteward, RoleProjectSteward, RoleProjectLead}
	case "Financial Steward":
		return []Role{RoleMember, RoleContributor}
	case "Governance Steward":
		return []Role{RoleMember, RoleContributor, RoleCommunitySteward}
	case "Treasury Steward":
		return []Role{RoleMember, RoleContributor}
	case "Technical Steward":
		return []Role{RoleMember, RoleContributor, RoleProjectLead}
	case "Cultural Steward":
		return []Role{RoleMember, RoleContributor, RoleCommunitySteward}
	default:
		// Custom roles: a credential role string matching a custom role in
		// the current policy grants [member, <custom-role>].
		if p := CurrentPolicy(); p.HasCustomRole(keriRole) {
			return []Role{RoleMember, Role(keriRole)}
		}
		return []Role{RoleMember}
	}
}

// Action represents a permissioned operation in the contributions system.
type Action string

const (
	ActionCreateContribution     Action = "create_contribution"
	ActionConfirmContribution    Action = "confirm_contribution"
	ActionAssignContribution     Action = "assign_contribution"
	ActionSignOffContribution    Action = "sign_off_contribution"
	ActionRewardContribution     Action = "reward_contribution"
	ActionTransitionContribution Action = "transition_contribution"
	ActionUpdateContribution     Action = "update_contribution"
	ActionCreateProject          Action = "create_project"
	ActionEditProject            Action = "edit_project"
	ActionDeleteProject          Action = "delete_project"
	ActionAssignProjectRole      Action = "assign_project_role"
	// assign_project_role split (#312/#313): the granular successors. They gate
	// no endpoint yet — the coarse assign_project_role route stays wired until
	// the projects enforcement slice splits it — but the capabilities exist so
	// grants can be configured ahead of enforcement.
	ActionAssignProjectSteward Action = "assign_project_steward"
	ActionAssignProjectLead    Action = "assign_project_lead"
	ActionLinkProposal         Action = "link_proposal"
	ActionRegisterInterest     Action = "register_interest"

	// Membership & credential actions
	ActionChangeMemberRole  Action = "change_member_role"
	ActionRemoveMember      Action = "remove_member"
	ActionInitMemberProfile Action = "init_member_profile"
	ActionStoreCredential   Action = "store_credential"

	// Workflow actions added in Stage 1
	ActionShareContribution  Action = "share_contribution"
	ActionOfferContribution  Action = "offer_contribution"
	ActionAcceptOffer        Action = "accept_offer"
	ActionSubmitEvidence     Action = "submit_evidence"
	ActionEditEvidence       Action = "edit_evidence"
	ActionReviewContribution Action = "review_contribution"
	ActionSignOffPlan        Action = "sign_off_plan"
	ActionApproveSubContrib  Action = "approve_sub_contribution"

	// Proposal actions
	ActionSignOffProposal  Action = "sign_off_proposal"
	ActionRejectProposal   Action = "reject_proposal"
	ActionEditProposal     Action = "edit_proposal"
	ActionWithdrawProposal Action = "withdraw_proposal"
	// ActionCreateProposal and ActionSubmitProposal are the proposal-authoring
	// actions (create_proposals capability, #315/#312): creating a draft proposal
	// and submitting it (draft → submitted). Not part of the legacy
	// actionPermissions table — create/submit had no role gate before, only the
	// resource layer — so these live solely in capabilityActions.
	ActionCreateProposal Action = "create_proposal"
	ActionSubmitProposal Action = "submit_proposal"

	// Archive & lifecycle actions
	ActionArchiveProject       Action = "archive_project"
	ActionArchiveMilestone     Action = "archive_milestone"
	ActionArchiveContribution  Action = "archive_contribution"
	ActionUnassignContribution Action = "unassign_contribution"
	ActionEditMilestone        Action = "edit_milestone"

	// Project completion workflow
	ActionSubmitProjectCompletion  Action = "submit_project_completion"
	ActionApproveProjectCompletion Action = "approve_project_completion"
	ActionRejectProjectCompletion  Action = "reject_project_completion"

	// Role-granting / bootstrap routes (issue #17 follow-up). These endpoints
	// hand out roles indirectly — org config admins resolve to Founding Member,
	// grant-steward-admin elevates any-sync ACL permissions, identity/set
	// decides which AID the backend treats as its owner — so they are limited
	// to adminScope once the backend is past first-run bootstrap (see
	// docs/RBAC.md "Bootstrap rule").
	ActionSaveOrgConfig     Action = "save_org_config"
	ActionGrantStewardAdmin Action = "grant_steward_admin"
	ActionSetIdentity       Action = "set_identity"

	// ActionWriteProfile gates POST /api/v1/profiles. Any authenticated member
	// may reach the handler; resource-level rules (owner / steward / role
	// change) are applied in api.profileWritePolicy.
	ActionWriteProfile Action = "write_profile"

	// Role-policy management (the manage_roles meta-permission)
	ActionManageRolePolicy Action = "manage_role_policy"

	// ActionSendMessage and the other chat actions (#316). Before this slice the
	// chat routes had no action wiring. send_message is the default-all capability (send_messages) — every
	// member role holds it, so gating the send endpoint is behaviour-neutral
	// until an admin narrows it. The channel-management actions map to
	// manage_channels (create/edit/archive a channel, set its AllowedRoles);
	// moderate_message maps to moderate_messages (delete another member's
	// message). Both default to stewards+founder.
	ActionSendMessage     Action = "send_message"
	ActionCreateChannel   Action = "create_channel"
	ActionEditChannel     Action = "edit_channel"
	ActionArchiveChannel  Action = "archive_channel"
	ActionSetChannelRoles Action = "set_channel_roles"
	ActionModerateMessage Action = "moderate_message"
)

// actionPermissions maps each action to the roles that can perform it.
// 5-role model: Community Admin (OperationsSteward/FoundingMember), Project Steward,
// Project Lead, Contributor, Member.
// allRoles is the full set of contribution-system roles. An action mapped to
// allRoles only verifies the caller is authenticated (has an X-User-AID that
// resolves to at least one role); resource-level checks for those actions
// live in the service/handler layer.
var allRoles = []Role{
	RoleMember, RoleContributor, RoleProjectLead, RoleProjectSteward,
	RoleCommunitySteward, RoleOperationsSteward, RoleFoundingMember,
}

var stewardScope = []Role{
	RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember,
}

var leadStewardScope = []Role{
	RoleProjectLead, RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember,
}

// adminScope is the community-admin tier: the same set that may change member
// roles. Used for routes that grant roles or ACL permissions.
var adminScope = []Role{
	RoleOperationsSteward, RoleFoundingMember,
}

var actionPermissions = map[Action][]Role{
	ActionCreateProject:          allRoles,
	ActionEditProject:            allRoles,
	ActionDeleteProject:          allRoles,
	ActionAssignProjectRole:      stewardScope,
	ActionLinkProposal:           leadStewardScope,
	ActionCreateContribution:     allRoles,
	ActionConfirmContribution:    allRoles,
	ActionAssignContribution:     allRoles,
	ActionSignOffContribution:    {RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember},
	ActionRewardContribution:     {RoleOperationsSteward, RoleFoundingMember},
	ActionTransitionContribution: allRoles,
	ActionUpdateContribution:     allRoles,
	ActionShareContribution:      allRoles,
	ActionOfferContribution:      allRoles,
	ActionAcceptOffer:            allRoles,
	ActionSubmitEvidence:         allRoles,
	ActionEditEvidence:           allRoles,
	ActionReviewContribution:     allRoles,
	ActionSignOffPlan:            {RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember},
	ActionApproveSubContrib:      allRoles,
	ActionRegisterInterest:       allRoles,

	// Membership & credential actions
	ActionChangeMemberRole:         {RoleOperationsSteward, RoleFoundingMember},
	ActionRemoveMember:             {RoleOperationsSteward, RoleFoundingMember},
	ActionInitMemberProfile:        stewardScope,
	ActionStoreCredential:          allRoles,
	ActionSignOffProposal:          {RoleProjectSteward, RoleOperationsSteward, RoleCommunitySteward, RoleFoundingMember},
	ActionRejectProposal:           {RoleProjectSteward, RoleOperationsSteward, RoleCommunitySteward, RoleFoundingMember},
	ActionEditProposal:             {RoleProjectSteward, RoleOperationsSteward, RoleCommunitySteward, RoleFoundingMember},
	ActionWithdrawProposal:         {RoleProjectSteward, RoleOperationsSteward, RoleCommunitySteward, RoleFoundingMember},
	ActionArchiveProject:           leadStewardScope,
	ActionArchiveMilestone:         leadStewardScope,
	ActionArchiveContribution:      leadStewardScope,
	ActionUnassignContribution:     leadStewardScope,
	ActionEditMilestone:            leadStewardScope,
	ActionSubmitProjectCompletion:  {RoleProjectLead, RoleOperationsSteward, RoleFoundingMember},
	ActionApproveProjectCompletion: stewardScope,
	ActionRejectProjectCompletion:  stewardScope,

	// Role-granting / bootstrap routes
	ActionSaveOrgConfig:     adminScope,
	ActionGrantStewardAdmin: adminScope,
	ActionSetIdentity:       adminScope,
	ActionWriteProfile:      allRoles,
}

// IsStewardScope reports whether the caller holds any steward-tier role
// (project steward, operations steward, founding member).
func IsStewardScope(roles []Role) bool {
	return hasAnyRole(roles, stewardScope)
}

// IsAdminScope reports whether the caller holds a community-admin role
// (operations steward, founding member).
func IsAdminScope(roles []Role) bool {
	return hasAnyRole(roles, adminScope)
}

func hasAnyRole(roles []Role, scope []Role) bool {
	for _, r := range roles {
		if HasRole(scope, r) {
			return true
		}
	}
	return false
}

// IsCompletionExempt reports whether the caller is exempt from the
// resource-level project-completion checks (submitter != approver, and
// lead/steward-of-this-project). Operations Stewards and Founding Members are
// exempt: they may submit/approve/reject any project's completion regardless
// of whether they are its lead or steward, and may approve their own
// submission. All other roles are bound by the per-project checks.
func IsCompletionExempt(roles []Role) bool {
	return HasRole(roles, RoleOperationsSteward) || HasRole(roles, RoleFoundingMember)
}

// HasRole checks if a role list contains the given role.
func HasRole(roles []Role, target Role) bool {
	for _, r := range roles {
		if r == target {
			return true
		}
	}
	return false
}

// CanPerformAction checks if any of the user's roles allows the given action
// under the community's current RolePolicy (synced, or built-in default).
// The legacy actionPermissions table above is retained as the permanent
// reference the default policy is proven equivalent to (policy_test.go
// legacyCan) — do not delete it.
func CanPerformAction(userRoles []Role, action Action) bool {
	return CanPerformActionWithPolicy(CurrentPolicy(), userRoles, action)
}
