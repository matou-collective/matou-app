package contributions

import "testing"

// Under the built-in default policy, view_contribution_amounts is granted to
// exactly project_lead and project_steward (#312 defaults), and NOT to a plain
// member/contributor — nor, by default, to the community-admin roles.
func TestCanViewContributionAmounts_RoleBased(t *testing.T) {
	SetPolicyProvider(nil) // default policy
	c := &Contribution{ID: "ctr1", Budget: "5000", ActualCost: 4200, AssignedContributorID: "EAssignee"}

	cases := []struct {
		name  string
		roles []Role
		want  bool
	}{
		{"plain member", []Role{RoleMember}, false},
		{"contributor", []Role{RoleMember, RoleContributor}, false},
		{"community steward", []Role{RoleMember, RoleCommunitySteward}, false},
		{"project lead", []Role{RoleMember, RoleProjectLead}, true},
		{"project steward", []Role{RoleMember, RoleProjectSteward}, true},
		// ops steward / founding member are not granted the capability by
		// default under #312 — amounts default to the project-scoped roles.
		{"operations steward", []Role{RoleMember, RoleOperationsSteward}, false},
		{"founding member", []Role{RoleMember, RoleFoundingMember}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// A non-assignee caller: visibility is purely role-based.
			if got := CanViewContributionAmounts(tc.roles, "ESomeoneElse", c); got != tc.want {
				t.Errorf("CanViewContributionAmounts(%v) = %v, want %v", tc.roles, got, tc.want)
			}
		})
	}
}

// The assigned contributor always sees the amounts on their own contribution,
// regardless of role — even a plain member.
func TestCanViewContributionAmounts_AssigneeAlwaysSees(t *testing.T) {
	SetPolicyProvider(nil)
	c := &Contribution{ID: "ctr1", Budget: "5000", AssignedContributorID: "EAssignee"}

	if !CanViewContributionAmounts([]Role{RoleMember}, "EAssignee", c) {
		t.Error("assigned contributor (plain member) should see amounts on their own contribution")
	}
	// Empty caller AID never matches the assignee, even if the field is empty.
	unassigned := &Contribution{ID: "ctr2"}
	if CanViewContributionAmounts([]Role{RoleMember}, "", unassigned) {
		t.Error("empty caller AID must not be treated as the assignee")
	}
}

func TestRedactContributionAmounts_CopiesAndClears(t *testing.T) {
	orig := &Contribution{ID: "ctr1", Title: "Fix", Budget: "5000", ActualCost: 4200}
	got := RedactContributionAmounts(orig)

	if got.Budget != "" || got.ActualCost != 0 {
		t.Errorf("redacted copy still carries amounts: budget=%q actualCost=%v", got.Budget, got.ActualCost)
	}
	if got.Title != "Fix" || got.ID != "ctr1" {
		t.Error("redaction must preserve non-amount fields")
	}
	// The original must be untouched — redaction returns a copy.
	if orig.Budget != "5000" || orig.ActualCost != 4200 {
		t.Errorf("original mutated by redaction: budget=%q actualCost=%v", orig.Budget, orig.ActualCost)
	}
	if RedactContributionAmounts(nil) != nil {
		t.Error("RedactContributionAmounts(nil) must be nil")
	}
}
