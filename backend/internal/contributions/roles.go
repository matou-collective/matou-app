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
	ActionSignOffProposal     Action = "sign_off_proposal"
	ActionRejectProposal      Action = "reject_proposal"
	ActionEditProposal        Action = "edit_proposal"
)

// actionPermissions maps each action to the roles that can perform it.
var actionPermissions = map[Action][]Role{
	ActionCreateContribution:  {RoleOperationsSteward, RoleProjectLead, RoleFoundingMember},
	ActionConfirmContribution: {RoleProjectSteward, RoleProjectLead, RoleOperationsSteward},
	ActionAssignContribution:  {RoleProjectLead, RoleOperationsSteward},
	ActionApproveContribution: {RoleProjectLead, RoleOperationsSteward},
	ActionSignOffContribution: {RoleProjectSteward, RoleOperationsSteward},
	ActionCreateProject:       {RoleOperationsSteward, RoleFoundingMember},
	ActionEditProject:         {RoleOperationsSteward, RoleFoundingMember},
	ActionDeleteProject:       {RoleOperationsSteward, RoleFoundingMember},
	ActionCreateSubContrib:    {RoleContributor, RoleProjectLead, RoleOperationsSteward},
	ActionRegisterInterest:    {RoleMember, RoleContributor, RoleProjectLead, RoleTechSteward, RoleCommunitySteward},
	ActionSignOffProposal:     {RoleProjectSteward, RoleOperationsSteward, RoleCommunitySteward, RoleFoundingMember},
	ActionRejectProposal:      {RoleProjectSteward, RoleOperationsSteward, RoleCommunitySteward, RoleFoundingMember},
	ActionEditProposal:        {RoleProjectSteward, RoleOperationsSteward, RoleCommunitySteward, RoleFoundingMember},
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
