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
		return nil
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
)

// actionPermissions maps each action to the roles that can perform it.
// 5-role model: Community Admin (OperationsSteward/FoundingMember), Project Steward,
// Project Lead, Contributor, Member.
var actionPermissions = map[Action][]Role{
	// Project management
	ActionCreateProject: {RoleOperationsSteward, RoleFoundingMember},
	ActionEditProject:   {RoleOperationsSteward, RoleFoundingMember, RoleProjectLead},
	ActionDeleteProject: {RoleOperationsSteward, RoleFoundingMember},

	// Contribution lifecycle
	ActionCreateContribution:  {RoleOperationsSteward, RoleFoundingMember, RoleProjectLead},
	ActionConfirmContribution: {RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember},
	ActionAssignContribution:  {RoleProjectLead, RoleOperationsSteward, RoleFoundingMember},
	ActionApproveContribution: {RoleProjectLead, RoleOperationsSteward, RoleFoundingMember},
	ActionSignOffContribution: {RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember},

	// Sharing & offering — lead, steward, admin
	ActionShareContribution: {RoleProjectLead, RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember},
	ActionOfferContribution: {RoleProjectLead, RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember},

	// Contributor self-service
	ActionAcceptOffer:    {RoleMember, RoleContributor, RoleProjectLead},
	ActionSubmitEvidence: {RoleContributor, RoleProjectLead, RoleOperationsSteward, RoleFoundingMember},

	// Review — lead and admin
	ActionReviewContribution: {RoleProjectLead, RoleOperationsSteward, RoleFoundingMember},

	// Plan sign-off — steward and admin
	ActionSignOffPlan: {RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember},

	// Sub-contributions
	ActionCreateSubContrib:   {RoleContributor, RoleProjectLead, RoleOperationsSteward, RoleFoundingMember},
	ActionApproveSubContrib:  {RoleProjectLead, RoleOperationsSteward, RoleFoundingMember},

	// Interest registration — all community members
	ActionRegisterInterest: {RoleMember, RoleContributor, RoleProjectLead, RoleTechSteward, RoleCommunitySteward, RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember},
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
