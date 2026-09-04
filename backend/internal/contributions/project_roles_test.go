package contributions

import "testing"

func TestStripProjectRoles(t *testing.T) {
	in := []Role{RoleMember, RoleContributor, RoleProjectLead, RoleProjectSteward, RoleOperationsSteward}
	got := StripProjectRoles(in)
	// Every per-project role (lead, steward, and contributor) is removed.
	for _, r := range got {
		if IsProjectRole(r) {
			t.Errorf("StripProjectRoles left a project role: %v (result %v)", r, got)
		}
	}
	// Community-wide roles survive so community-scope grants still apply.
	if !HasRole(got, RoleMember) || !HasRole(got, RoleOperationsSteward) {
		t.Errorf("StripProjectRoles dropped a community role: %v", got)
	}
}

func TestIsProjectScopedAction(t *testing.T) {
	scoped := []Action{
		ActionSignOffContribution, ActionSignOffPlan, ActionSubmitProjectCompletion,
		ActionApproveProjectCompletion, ActionRejectProjectCompletion, ActionArchiveProject,
		ActionArchiveMilestone, ActionArchiveContribution, ActionUnassignContribution,
		ActionEditMilestone, ActionLinkProposal, ActionAssignProjectRole,
	}
	for _, a := range scoped {
		if !IsProjectScopedAction(a) {
			t.Errorf("expected %s to be project-scoped", a)
		}
	}
	community := []Action{
		ActionCreateContribution, ActionRewardContribution, ActionChangeMemberRole,
		ActionSignOffProposal, ActionCreateProject, ActionSubmitEvidence,
	}
	for _, a := range community {
		if IsProjectScopedAction(a) {
			t.Errorf("expected %s to be community-scoped", a)
		}
	}
}

// TestCanPerformProjectAction_LeadScopedToOwnProject is the core of issue #166:
// a credential that maps to project_lead (Technical Steward) is NOT lead of
// every project — only an actual assignment on the target project counts.
func TestCanPerformProjectAction_LeadScopedToOwnProject(t *testing.T) {
	techSteward := MapKERIRole("Technical Steward") // [member, contributor, project_lead]

	// Not assigned to the project → credential-derived project_lead is stripped,
	// so submit-completion is denied.
	if CanPerformProjectAction(techSteward, nil, ActionSubmitProjectCompletion) {
		t.Error("a credential-derived lead must not submit completion on an unassigned project")
	}
	// Assigned lead on the target project → allowed.
	if !CanPerformProjectAction(techSteward, []Role{RoleProjectLead}, ActionSubmitProjectCompletion) {
		t.Error("the assigned project lead must be able to submit completion")
	}
}

func TestCanPerformProjectAction_StewardScopedToOwnProject(t *testing.T) {
	communitySteward := MapKERIRole("Community Steward") // includes project_steward via credential

	if CanPerformProjectAction(communitySteward, nil, ActionSignOffContribution) {
		t.Error("a credential-derived steward must not sign off on an unassigned project")
	}
	if !CanPerformProjectAction(communitySteward, []Role{RoleProjectSteward}, ActionSignOffContribution) {
		t.Error("the assigned project steward must be able to sign off")
	}
}

// Community-scope grants (Operations Steward / Founding Member) keep their power
// on every project without any assignment — that survives the strip-and-reunion.
func TestCanPerformProjectAction_CommunityAdminPassesEverywhere(t *testing.T) {
	for _, keriRole := range []string{"Operations Steward", "Founding Member"} {
		roles := MapKERIRole(keriRole)
		for _, a := range []Action{ActionSubmitProjectCompletion, ActionSignOffContribution, ActionAssignProjectRole, ActionApproveProjectCompletion} {
			if !CanPerformProjectAction(roles, nil, a) {
				t.Errorf("%s should pass %s on any project via community-scope grant", keriRole, a)
			}
		}
	}
}

func TestCanPerformProjectAction_PlainMemberDenied(t *testing.T) {
	member := MapKERIRole("Member")
	for _, a := range []Action{ActionSubmitProjectCompletion, ActionSignOffContribution, ActionAssignProjectRole} {
		if CanPerformProjectAction(member, nil, a) {
			t.Errorf("an unassigned plain member must be denied %s", a)
		}
	}
}
