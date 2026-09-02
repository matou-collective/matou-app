package contributions

import (
	"context"
	"errors"
	"testing"
)

func TestServiceProjectRoles(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	const space = "space-1"

	proj, err := svc.CreateProject(ctx, space, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "creator"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	proj.ProjectLeadID = "aid-lead"
	proj.ProjectStewardID = "aid-steward"
	if err := svc.SaveProject(ctx, space, proj); err != nil {
		t.Fatalf("save project: %v", err)
	}

	c, err := svc.CreateContribution(ctx, space, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "T", Description: "d",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow, CreatedBy: "creator",
		Objectives: []string{"o"}, Deliverables: []string{"d"},
		AcceptanceCriteria: []string{"a"}, SkillRequirements: []string{"s"},
	})
	if err != nil {
		t.Fatalf("create contribution: %v", err)
	}
	svc.TransitionContribution(ctx, space, c.ID, ContribConfirmed)
	if _, err := svc.AssignContributor(ctx, space, c.ID, "aid-contributor"); err != nil {
		t.Fatalf("assign contributor: %v", err)
	}

	cases := []struct {
		aid  string
		want []Role
	}{
		{"aid-lead", []Role{RoleProjectLead}},
		{"aid-steward", []Role{RoleProjectSteward}},
		{"aid-contributor", []Role{RoleContributor}},
		{"aid-stranger", nil},
		{"", nil},
	}
	for _, tc := range cases {
		got := svc.ProjectRoles(ctx, space, proj.ID, tc.aid)
		if !sameRoleSet(got, tc.want) {
			t.Errorf("ProjectRoles(%q) = %v, want %v", tc.aid, got, tc.want)
		}
	}

	// Unknown project → no roles.
	if got := svc.ProjectRoles(ctx, space, "missing", "aid-lead"); len(got) != 0 {
		t.Errorf("ProjectRoles(missing) = %v, want none", got)
	}
}

func TestSubmitEvidenceRequiresAssignedContributor(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	const space = "space-1"

	c, err := svc.CreateContribution(ctx, space, &CreateContributionRequest{
		ProjectID: "proj-1", Title: "T", Description: "d",
		ContributionType: ProposalTypeTechnical, Priority: PriorityLow, CreatedBy: "creator",
		Objectives: []string{"o"}, Deliverables: []string{"d"},
		AcceptanceCriteria: []string{"a"}, SkillRequirements: []string{"s"},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	svc.TransitionContribution(ctx, space, c.ID, ContribConfirmed)
	if _, err := svc.AssignContributor(ctx, space, c.ID, "assignee"); err != nil {
		t.Fatalf("assign: %v", err)
	}

	// A member who is not the assignee is rejected as not the evidence owner.
	if _, err := svc.SubmitEvidence(ctx, space, c.ID, "stranger", SubmitEvidenceRequest{CompletionNotes: "x"}); !errors.Is(err, ErrNotEvidenceOwner) {
		t.Errorf("stranger SubmitEvidence err = %v, want ErrNotEvidenceOwner", err)
	}
	// The assigned contributor succeeds.
	if _, err := svc.SubmitEvidence(ctx, space, c.ID, "assignee", SubmitEvidenceRequest{CompletionNotes: "done"}); err != nil {
		t.Errorf("assignee SubmitEvidence err = %v, want nil", err)
	}
}

func sameRoleSet(a, b []Role) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[Role]int{}
	for _, r := range a {
		seen[r]++
	}
	for _, r := range b {
		seen[r]--
	}
	for _, v := range seen {
		if v != 0 {
			return false
		}
	}
	return true
}
