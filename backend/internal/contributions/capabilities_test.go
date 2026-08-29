// backend/internal/contributions/capabilities_test.go
package contributions

import "testing"

// Every existing action must belong to exactly one capability.
func TestEveryActionHasExactlyOneCapability(t *testing.T) {
	allActions := []Action{
		ActionCreateContribution, ActionConfirmContribution, ActionAssignContribution,
		ActionSignOffContribution, ActionRewardContribution,
		ActionCreateProject, ActionEditProject, ActionDeleteProject,
		ActionAssignProjectRole, ActionLinkProposal, ActionRegisterInterest,
		ActionTransitionContribution, ActionUpdateContribution, ActionEditEvidence,
		ActionStoreCredential, ActionWriteProfile,
		ActionSaveOrgConfig, ActionGrantStewardAdmin, ActionSetIdentity,
		ActionShareContribution, ActionOfferContribution, ActionAcceptOffer,
		ActionSubmitEvidence, ActionReviewContribution, ActionSignOffPlan,
		ActionApproveSubContrib,
		ActionSignOffProposal, ActionRejectProposal, ActionEditProposal, ActionWithdrawProposal,
		ActionArchiveProject, ActionArchiveMilestone, ActionArchiveContribution,
		ActionUnassignContribution, ActionEditMilestone,
		ActionSubmitProjectCompletion, ActionApproveProjectCompletion, ActionRejectProjectCompletion,
		ActionInitMemberProfile, ActionChangeMemberRole, ActionRemoveMember, ActionManageRolePolicy,
	}
	for _, a := range allActions {
		count := 0
		for _, actions := range CapabilityActions() {
			for _, ca := range actions {
				if ca == a {
					count++
				}
			}
		}
		if count != 1 {
			t.Errorf("action %q appears in %d capabilities, want exactly 1", a, count)
		}
	}
}

func TestActionCapabilityReverseLookup(t *testing.T) {
	cap, ok := ActionCapability(ActionSignOffContribution)
	if !ok || cap != CapSignOff {
		t.Errorf("ActionCapability(sign_off_contribution) = %q, %v; want %q, true", cap, ok, CapSignOff)
	}
	if _, ok := ActionCapability(Action("nonexistent")); ok {
		t.Error("ActionCapability(nonexistent) should return ok=false")
	}
}

func TestAllCapabilitiesStable(t *testing.T) {
	caps := AllCapabilities()
	if len(caps) != 13 {
		t.Errorf("AllCapabilities() returned %d capabilities, want 13", len(caps))
	}
	// manage_communications intentionally has no actions yet (routes unwired; see spec §2 note)
	if actions := CapabilityActions()[CapManageComms]; len(actions) != 0 {
		t.Errorf("manage_communications should map to no actions yet, got %v", actions)
	}
}
