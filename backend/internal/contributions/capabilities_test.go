// backend/internal/contributions/capabilities_test.go
package contributions

import "testing"

// Every existing action must belong to exactly one capability.
func TestEveryActionHasExactlyOneCapability(t *testing.T) {
	allActions := []Action{
		ActionCreateContribution, ActionConfirmContribution, ActionAssignContribution,
		ActionSignOffContribution, ActionRewardContribution,
		ActionCreateProject, ActionEditProject, ActionDeleteProject,
		ActionAssignProjectRole, ActionAssignProjectSteward, ActionAssignProjectLead,
		ActionLinkProposal, ActionRegisterInterest,
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
		ActionSendMessage, ActionCreateChannel, ActionEditChannel, ActionArchiveChannel,
		ActionSetChannelRoles, ActionModerateMessage,
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

func TestProjectScopedCapabilities(t *testing.T) {
	got := ProjectScopedCapabilities()
	// Project-scoped capabilities in AllCapabilities() display order. reward is
	// community-scoped; the three new project caps (view_contribution_amounts,
	// assign_project_steward, assign_project_lead) join the existing seven.
	want := []Capability{
		CapContribute, CapManageProjects, CapReviewWork, CapSignOff,
		CapSubmitCompletion, CapApproveCompletion, CapArchiveWork,
		CapViewContributionAmounts, CapAssignProjectSteward, CapAssignProjectLead,
	}
	if len(got) != len(want) {
		t.Fatalf("ProjectScopedCapabilities() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("ProjectScopedCapabilities()[%d] = %q, want %q (must follow AllCapabilities order)", i, got[i], want[i])
		}
	}
	// The community-only capabilities must NOT be project-scoped.
	for _, c := range []Capability{
		CapReward, CapManageMembers, CapManageGovernance, CapManageRoles,
		CapCreateProposals, CapSendMessages, CapManageChannels, CapModerateMessages,
		CapPostNotices, CapManageNotices, CapOpenCommunitySettings, CapManageCommunitySettings,
	} {
		if IsProjectScopedCapability(c) {
			t.Errorf("%q must be community-only, not project-scoped", c)
		}
	}
}

func TestAllCapabilitiesStable(t *testing.T) {
	caps := AllCapabilities()
	// 13 original − 2 retired (assign_work, manage_communications) + 11 new = 22.
	if len(caps) != 22 {
		t.Errorf("AllCapabilities() returned %d capabilities, want 22", len(caps))
	}
	// Retired capabilities must not appear in the toggleable set.
	for _, c := range caps {
		if IsRetiredCapability(c) {
			t.Errorf("retired capability %q must not be in AllCapabilities()", c)
		}
	}
	// The remaining feature capabilities intentionally gate no action yet —
	// grants can be configured ahead of the enforcement slices that wire them.
	// The chat capabilities (send_messages, manage_channels, moderate_messages)
	// are now wired (#316) and so are excluded from this set.
	for _, c := range []Capability{
		CapViewContributionAmounts, CapCreateProposals,
		CapPostNotices, CapManageNotices,
		CapOpenCommunitySettings, CapManageCommunitySettings,
	} {
		if actions := CapabilityActions()[c]; len(actions) != 0 {
			t.Errorf("%q should map to no actions yet, got %v", c, actions)
		}
	}
	// The chat capabilities are wired (#316).
	for _, c := range []Capability{CapSendMessages, CapManageChannels, CapModerateMessages} {
		if actions := CapabilityActions()[c]; len(actions) == 0 {
			t.Errorf("%q should map to at least one action (#316)", c)
		}
	}
	// Every capability metadata entry corresponds to a toggleable capability and
	// carries a group and scope.
	if len(CapabilityMetadata()) != len(caps) {
		t.Errorf("CapabilityMetadata() has %d entries, want %d (one per capability)", len(CapabilityMetadata()), len(caps))
	}
	for _, m := range CapabilityMetadata() {
		if m.DisplayName == "" || m.Group == "" {
			t.Errorf("capability %q missing display name or group", m.ID)
		}
		if m.Scope != ScopeCommunity && m.Scope != ScopeProject {
			t.Errorf("capability %q has invalid scope %q", m.ID, m.Scope)
		}
	}
}

func TestRetiredCapabilities(t *testing.T) {
	if !IsRetiredCapability(CapAssignWork) || !IsRetiredCapability(CapManageComms) {
		t.Fatal("assign_work and manage_communications must be retired")
	}
	if IsRetiredCapability(CapAssignProjectSteward) {
		t.Error("assign_project_steward is a successor, not retired")
	}
	if got := RetiredCapabilitySuccessors(CapAssignWork); len(got) != 2 ||
		got[0] != CapAssignProjectSteward || got[1] != CapAssignProjectLead {
		t.Errorf("assign_work successors = %v, want [assign_project_steward assign_project_lead]", got)
	}
	if got := RetiredCapabilitySuccessors(CapManageComms); len(got) != 2 ||
		got[0] != CapManageChannels || got[1] != CapModerateMessages {
		t.Errorf("manage_communications successors = %v, want [manage_channels moderate_messages]", got)
	}
	if RetiredCapabilitySuccessors(CapContribute) != nil {
		t.Error("a live capability has no successors")
	}
}
