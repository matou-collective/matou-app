package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/matou-dao/backend/internal/contributions"
)

// fakePolicyProvider serves a fixed policy so tests can grant a custom role
// exactly one capability (used by the assign-role split test).
type fakePolicyProvider struct{ p *contributions.RolePolicy }

func (f fakePolicyProvider) Policy() *contributions.RolePolicy { return f.p }

// seedContribution creates a contribution in the given project under the
// "community" space (the nil-SpaceManager default) with a budget and an
// assignee, returning its ID.
func seedContribution(t *testing.T, svc *contributions.Service, projectID, budget, assignee string) string {
	t.Helper()
	c, err := svc.CreateContribution(context.Background(), "community", &contributions.CreateContributionRequest{
		ProjectID:             projectID,
		Title:                 "Build the thing",
		Description:           "A seeded contribution",
		Objectives:            []string{"obj"},
		Deliverables:          []string{"del"},
		AcceptanceCriteria:    []string{"crit"},
		Budget:                budget,
		AssignedContributorID: assignee,
		CreatedBy:             "EAdmin",
	})
	if err != nil {
		t.Fatalf("seed contribution: %v", err)
	}
	return c.ID
}

// seedProjectWithSteward creates a project under the "community" space and, when
// steward is non-empty, assigns it as the project's steward (mirroring an
// assign-role grant), returning the project ID.
func seedProjectWithSteward(t *testing.T, svc *contributions.Service, title, steward string) string {
	t.Helper()
	p, err := svc.CreateProject(context.Background(), "community", &contributions.CreateProjectRequest{
		Title: title, Description: "A test project", CreatedBy: "EAdmin",
	})
	if err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if steward != "" {
		p.ProjectStewardID = steward
		if err := svc.SaveProject(context.Background(), "community", p); err != nil {
			t.Fatalf("save project steward: %v", err)
		}
	}
	return p.ID
}

// getContributionBudget drives GET /api/v1/contributions/{id} as the given
// caller and returns the (status, budget) the caller sees.
func getContributionBudget(t *testing.T, mux *http.ServeMux, id, aid string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/contributions/"+id, nil)
	if aid != "" {
		req.Header.Set("X-User-AID", aid)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	var body struct {
		Budget     string  `json:"budget"`
		ActualCost float64 `json:"actual_cost"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w.Code, body.Budget
}

// TestContributionAmounts_StrippedForCallersWithoutCapability verifies the
// view_contribution_amounts enforcement on contribution reads (#314): a plain
// member (and an anonymous caller) get the budget stripped, while a steward
// (role grant) and the assigned contributor (resource-level rule) see it. Under
// #373 the steward's grant is now resolved against the contribution's OWNING
// project, so ESteward is assigned as steward on that project.
func TestContributionAmounts_StrippedForCallersWithoutCapability(t *testing.T) {
	contributions.SetPolicyProvider(nil) // built-in default policy
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	h := NewContributionsHandler(svc, nil, nil)

	projID := seedProjectWithSteward(t, svc, "Proj", "ESteward")
	id := seedContribution(t, svc, projID, "5000", "EAssignee")

	mux := http.NewServeMux()
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{
		"EMember":   {contributions.RoleMember, contributions.RoleContributor},
		"ESteward":  {contributions.RoleMember, contributions.RoleProjectSteward},
		"EAssignee": {contributions.RoleMember}, // plain member, but the assignee
	}}
	h.RegisterRoutes(mux, lookup)

	t.Run("plain member: stripped", func(t *testing.T) {
		code, budget := getContributionBudget(t, mux, id, "EMember")
		if code != http.StatusOK {
			t.Fatalf("expected 200, got %d", code)
		}
		if budget != "" {
			t.Errorf("plain member must not see the budget, got %q", budget)
		}
	})
	t.Run("anonymous: stripped", func(t *testing.T) {
		if _, budget := getContributionBudget(t, mux, id, ""); budget != "" {
			t.Errorf("anonymous caller must not see the budget, got %q", budget)
		}
	})
	t.Run("steward: visible", func(t *testing.T) {
		if _, budget := getContributionBudget(t, mux, id, "ESteward"); budget != "5000" {
			t.Errorf("steward should see the budget, got %q", budget)
		}
	})
	t.Run("assignee: visible", func(t *testing.T) {
		if _, budget := getContributionBudget(t, mux, id, "EAssignee"); budget != "5000" {
			t.Errorf("assigned contributor should see the budget on their own contribution, got %q", budget)
		}
	})
}

// TestContributionAmounts_ProjectScoped verifies that view_contribution_amounts
// is resolved per project (#373): a steward assigned on project A sees amounts on
// A's contribution but they are redacted on B's, and a plain member sees amounts
// only on contributions they are the assignee of. A credential-derived
// project_steward community role does not reveal amounts on projects the caller
// is not actually assigned to.
func TestContributionAmounts_ProjectScoped(t *testing.T) {
	contributions.SetPolicyProvider(nil) // built-in default policy
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	h := NewContributionsHandler(svc, nil, nil)

	// EStewardA is steward of A only; B has no assigned steward.
	projA := seedProjectWithSteward(t, svc, "A", "EStewardA")
	projB := seedProjectWithSteward(t, svc, "B", "")
	idA := seedContribution(t, svc, projA, "5000", "EAssigneeA")
	idB := seedContribution(t, svc, projB, "9000", "EAssigneeB")

	mux := http.NewServeMux()
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{
		// Credential-derived project_steward: under #373 counts only where actually assigned.
		"EStewardA":  {contributions.RoleMember, contributions.RoleProjectSteward},
		"EMember":    {contributions.RoleMember},
		"EAssigneeB": {contributions.RoleMember},
	}}
	h.RegisterRoutes(mux, lookup)

	t.Run("steward of A sees amounts on A", func(t *testing.T) {
		if _, budget := getContributionBudget(t, mux, idA, "EStewardA"); budget != "5000" {
			t.Errorf("steward of A should see A's budget, got %q", budget)
		}
	})
	t.Run("steward of A redacted on B", func(t *testing.T) {
		if _, budget := getContributionBudget(t, mux, idB, "EStewardA"); budget != "" {
			t.Errorf("steward of A must not see B's budget, got %q", budget)
		}
	})
	t.Run("plain member redacted on A", func(t *testing.T) {
		if _, budget := getContributionBudget(t, mux, idA, "EMember"); budget != "" {
			t.Errorf("plain member must not see A's budget, got %q", budget)
		}
	})
	t.Run("plain member sees own contribution amounts", func(t *testing.T) {
		if _, budget := getContributionBudget(t, mux, idB, "EAssigneeB"); budget != "9000" {
			t.Errorf("assignee should see amounts on their own contribution, got %q", budget)
		}
	})
}

// assignRole drives POST /api/v1/projects/{id}/assign-role as the given caller.
func assignRole(t *testing.T, mux *http.ServeMux, projectID, role, aid string) int {
	t.Helper()
	body := `{"role":"` + role + `","user_id":"ETarget"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+projectID+"/assign-role", strings.NewReader(body))
	req.Header.Set("X-User-AID", aid)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	return w.Code
}

// TestAssignProjectRole_GranularCapabilityEnforced verifies the split of the
// coarse assign_project_role check into assign_project_lead /
// assign_project_steward (#314): a role granted only one of the two may assign
// only that side.
func TestAssignProjectRole_GranularCapabilityEnforced(t *testing.T) {
	// Custom policy: two project roles, each holding exactly one assign cap.
	policy := &contributions.RolePolicy{
		Version: 1,
		Roles: []contributions.RoleDef{
			{ID: "lead_assigner", DisplayName: "Lead Assigner", Scope: contributions.ScopeProject},
			{ID: "steward_assigner", DisplayName: "Steward Assigner", Scope: contributions.ScopeProject},
		},
		Grants: map[string][]contributions.Capability{
			"lead_assigner":    {contributions.CapAssignProjectLead},
			"steward_assigner": {contributions.CapAssignProjectSteward},
		},
	}
	contributions.SetPolicyProvider(fakePolicyProvider{p: policy})
	t.Cleanup(func() { contributions.SetPolicyProvider(nil) })

	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	h := NewProjectsHandler(svc, nil, nil)

	// A project must exist so the allowed path reaches SaveProject (200) rather
	// than 404 — 404 would still prove "not 403", but 200 is the crisper signal.
	proj, err := svc.CreateProject(context.Background(), "community", &contributions.CreateProjectRequest{
		Title: "Proj", Description: "A test project", CreatedBy: "EAdmin",
	})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}

	mux := http.NewServeMux()
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{
		"ELeadAssigner":    {contributions.Role("lead_assigner")},
		"EStewardAssigner": {contributions.Role("steward_assigner")},
	}}
	h.RegisterRoutes(mux, lookup)

	// lead_assigner: may assign lead, not steward.
	if code := assignRole(t, mux, proj.ID, "lead", "ELeadAssigner"); code != http.StatusOK {
		t.Errorf("lead_assigner assigning lead: expected 200, got %d", code)
	}
	if code := assignRole(t, mux, proj.ID, "steward", "ELeadAssigner"); code != http.StatusForbidden {
		t.Errorf("lead_assigner assigning steward: expected 403, got %d", code)
	}

	// steward_assigner: may assign steward, not lead.
	if code := assignRole(t, mux, proj.ID, "steward", "EStewardAssigner"); code != http.StatusOK {
		t.Errorf("steward_assigner assigning steward: expected 200, got %d", code)
	}
	if code := assignRole(t, mux, proj.ID, "lead", "EStewardAssigner"); code != http.StatusForbidden {
		t.Errorf("steward_assigner assigning lead: expected 403, got %d", code)
	}
}

// TestAssignProjectRole_ProjectScoped verifies that the granular assign check
// is project-scoped (#166 ∩ #314): a project steward assigned on project A may
// assign a steward on A but not on B, and a credential-derived project_steward
// community role does not make the holder steward of every project.
func TestAssignProjectRole_ProjectScoped(t *testing.T) {
	contributions.SetPolicyProvider(nil) // built-in default policy
	store := contributions.NewMockStore()
	svc := contributions.NewService(store)
	h := NewProjectsHandler(svc, nil, nil)

	mk := func(title string) *contributions.Project {
		p, err := svc.CreateProject(context.Background(), "community", &contributions.CreateProjectRequest{
			Title: title, Description: "A test project", CreatedBy: "EAdmin",
		})
		if err != nil {
			t.Fatalf("create project: %v", err)
		}
		return p
	}
	a, b := mk("A"), mk("B")
	a.ProjectStewardID = "EStewardA"
	if err := svc.SaveProject(context.Background(), "community", a); err != nil {
		t.Fatalf("save project: %v", err)
	}

	mux := http.NewServeMux()
	lookup := &mockRoleLookup{roles: map[string][]contributions.Role{
		// Credential-derived project_steward: only counts where actually assigned.
		"EStewardA": {contributions.RoleMember, contributions.RoleProjectSteward},
		"EMember":   {contributions.RoleMember},
	}}
	h.RegisterRoutes(mux, lookup)

	if code := assignRole(t, mux, a.ID, "steward", "EStewardA"); code != http.StatusOK {
		t.Errorf("steward of A assigning steward on A: expected 200, got %d", code)
	}
	if code := assignRole(t, mux, b.ID, "steward", "EStewardA"); code != http.StatusForbidden {
		t.Errorf("steward of A assigning steward on B: expected 403, got %d", code)
	}
	if code := assignRole(t, mux, a.ID, "steward", "EMember"); code != http.StatusForbidden {
		t.Errorf("plain member assigning steward on A: expected 403, got %d", code)
	}
}
