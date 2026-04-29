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
	RoleTechSteward       Role = "tech_steward"
	RoleTreasurySteward   Role = "treasury_steward"
	RoleFoundingMember    Role = "founding_member"
	RoleElderCouncil      Role = "elder_council"
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
		return []Role{RoleMember, RoleContributor, RoleTreasurySteward}
	case "Governance Steward":
		return []Role{RoleMember, RoleContributor, RoleCommunitySteward}
	case "Treasury Steward":
		return []Role{RoleMember, RoleContributor, RoleTreasurySteward}
	case "Technical Steward":
		return []Role{RoleMember, RoleContributor, RoleTechSteward, RoleProjectLead}
	case "Cultural Steward":
		return []Role{RoleMember, RoleContributor, RoleCommunitySteward}
	default:
		return []Role{RoleMember}
	}
}

// Action represents a permissioned operation in the contributions system.
type Action string

const (
	ActionCreateContribution  Action = "create_contribution"
	ActionConfirmContribution Action = "confirm_contribution"
	ActionAssignContribution  Action = "assign_contribution"
	ActionApproveContribution Action = "approve_contribution"
	ActionSignOffContribution Action = "sign_off_contribution"
	ActionCreateProject       Action = "create_project"
	ActionEditProject         Action = "edit_project"
	ActionDeleteProject       Action = "delete_project"
	ActionCreateSubContrib    Action = "create_sub_contribution"
	ActionRegisterInterest    Action = "register_interest"

	// Workflow actions added in Stage 1
	ActionShareContribution  Action = "share_contribution"
	ActionOfferContribution  Action = "offer_contribution"
	ActionAcceptOffer        Action = "accept_offer"
	ActionSubmitEvidence     Action = "submit_evidence"
	ActionReviewContribution Action = "review_contribution"
	ActionSignOffPlan        Action = "sign_off_plan"
	ActionApproveSubContrib  Action = "approve_sub_contribution"

	// Proposal actions
	ActionSignOffProposal Action = "sign_off_proposal"
	ActionRejectProposal  Action = "reject_proposal"
	ActionEditProposal    Action = "edit_proposal"

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
)

// actionPermissions maps each action to the roles that can perform it.
// 5-role model: Community Admin (OperationsSteward/FoundingMember), Project Steward,
// Project Lead, Contributor, Member.
// allRoles is the full set of contribution-system roles.
// Backend RBAC verifies the user is authenticated; project-level permission
// checks (lead, steward, admin) are enforced on the frontend.
var allRoles = []Role{
	RoleMember, RoleContributor, RoleProjectLead, RoleProjectSteward,
	RoleCommunitySteward, RoleTechSteward, RoleTreasurySteward,
	RoleOperationsSteward, RoleFoundingMember, RoleElderCouncil,
}

var stewardScope = []Role{
	RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember,
}

var leadStewardScope = []Role{
	RoleProjectLead, RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember,
}

var actionPermissions = map[Action][]Role{
	ActionCreateProject:       allRoles,
	ActionEditProject:         allRoles,
	ActionDeleteProject:       allRoles,
	ActionCreateContribution:  allRoles,
	ActionConfirmContribution: allRoles,
	ActionAssignContribution:  allRoles,
	ActionApproveContribution: allRoles,
	ActionSignOffContribution: {RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember},
	ActionShareContribution:   allRoles,
	ActionOfferContribution:   allRoles,
	ActionAcceptOffer:         allRoles,
	ActionSubmitEvidence:      allRoles,
	ActionReviewContribution:  allRoles,
	ActionSignOffPlan:         {RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember},
	ActionCreateSubContrib:    allRoles,
	ActionApproveSubContrib:   allRoles,
	ActionRegisterInterest:    allRoles,
	ActionSignOffProposal:     {RoleProjectSteward, RoleOperationsSteward, RoleCommunitySteward, RoleFoundingMember},
	ActionRejectProposal:      {RoleProjectSteward, RoleOperationsSteward, RoleCommunitySteward, RoleFoundingMember},
	ActionEditProposal:        {RoleProjectSteward, RoleOperationsSteward, RoleCommunitySteward, RoleFoundingMember},
	ActionArchiveProject:           leadStewardScope,
	ActionArchiveMilestone:         leadStewardScope,
	ActionArchiveContribution:      leadStewardScope,
	ActionUnassignContribution:     leadStewardScope,
	ActionEditMilestone:            leadStewardScope,
	ActionSubmitProjectCompletion:  {RoleProjectLead, RoleOperationsSteward, RoleFoundingMember},
	ActionApproveProjectCompletion: stewardScope,
	ActionRejectProjectCompletion:  stewardScope,
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

// CanPerformAction checks if any of the user's roles allows the given action.
func CanPerformAction(userRoles []Role, action Action) bool {
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
