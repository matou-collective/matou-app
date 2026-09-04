package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/matou-dao/backend/internal/contributions"
)

type fakeCommunityRoles map[string][]contributions.Role

func (f fakeCommunityRoles) GetUserRoles(aid string) ([]contributions.Role, error) {
	return f[aid], nil
}

// fakeProjectRoles maps projectID → aid → roles.
type fakeProjectRoles map[string]map[string][]contributions.Role

func (f fakeProjectRoles) ProjectRoles(_ context.Context, _ /*spaceID*/, projectID, aid string) []contributions.Role {
	return f[projectID][aid]
}

// serveProjectAction runs the project-scoped middleware for a given caller and
// target project, returning the HTTP status.
func serveProjectAction(t *testing.T, community RoleLookup, projects ProjectRoleLookup, action contributions.Action, aid, projectID string) int {
	t.Helper()
	next := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }
	resolve := func(*http.Request, string) (string, error) { return projectID, nil }
	handler := RBACMiddleware(community, RequireProjectAction(action, projects, nil, resolve, next))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+projectID+"/submit-completion", nil)
	req.Header.Set("X-User-AID", aid)
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec.Code
}

func TestRequireProjectAction_LeadScopedToOwnProject(t *testing.T) {
	// "lead-A" is a plain community Member who is assigned lead of project A only.
	community := fakeCommunityRoles{
		"lead-A":    contributions.MapKERIRole("Member"),
		"member":    contributions.MapKERIRole("Member"),
		"ops":       contributions.MapKERIRole("Operations Steward"),
		"tech-cred": contributions.MapKERIRole("Technical Steward"), // credential-derived project_lead
	}
	projects := fakeProjectRoles{
		"A": {"lead-A": {contributions.RoleProjectLead}},
	}
	const action = contributions.ActionSubmitProjectCompletion

	if got := serveProjectAction(t, community, projects, action, "lead-A", "A"); got != http.StatusOK {
		t.Errorf("lead of A on project A: status = %d, want 200", got)
	}
	if got := serveProjectAction(t, community, projects, action, "lead-A", "B"); got != http.StatusForbidden {
		t.Errorf("lead of A on project B: status = %d, want 403", got)
	}
	if got := serveProjectAction(t, community, projects, action, "member", "A"); got != http.StatusForbidden {
		t.Errorf("unassigned member on project A: status = %d, want 403", got)
	}
	// A Technical Steward credential (maps to project_lead community-globally)
	// must NOT be treated as lead of a project they were never assigned to.
	if got := serveProjectAction(t, community, projects, action, "tech-cred", "B"); got != http.StatusForbidden {
		t.Errorf("credential-derived lead on unassigned project B: status = %d, want 403", got)
	}
	// Operations Steward passes everywhere via a community-scope grant.
	if got := serveProjectAction(t, community, projects, action, "ops", "B"); got != http.StatusOK {
		t.Errorf("operations steward on any project: status = %d, want 200", got)
	}
}
