package api

import (
	"context"
	"log"
	"net/http"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
)

// ProjectRoleLookup resolves the per-project roles an AID holds on a given
// project (project_lead / project_steward from assign-role, contributor from
// contribution assignment). *contributions.Service satisfies it.
type ProjectRoleLookup interface {
	ProjectRoles(ctx context.Context, spaceID, projectID, aid string) []contributions.Role
}

// ProjectIDResolver extracts the target project ID for a request, either from a
// route parameter or by loading the resource chain (contribution / plan /
// milestone → project). It receives the already-resolved community space ID so
// resolvers that need to load an object can reuse it. Returning ("", err) or an
// empty project ID makes the project-scoped check deny with 403.
type ProjectIDResolver func(r *http.Request, spaceID string) (string, error)

// staticProjectID is the resolver for routes whose {id} path segment IS the
// project ID (e.g. /projects/{id}/...).
func staticProjectID(id string) ProjectIDResolver {
	return func(*http.Request, string) (string, error) { return id, nil }
}

// projectRBAC wraps a project-scoped handler in RBACMiddleware +
// RequireProjectAction when a roleLookup is configured. A nil roleLookup (unit
// tests that exercise handlers directly) bypasses auth, matching the other
// handlers' withRBAC helpers.
func projectRBAC(
	roleLookup RoleLookup,
	action contributions.Action,
	lookup ProjectRoleLookup,
	sm *anysync.SpaceManager,
	resolve ProjectIDResolver,
	handler http.HandlerFunc,
) http.HandlerFunc {
	if roleLookup == nil {
		return handler
	}
	return RBACMiddleware(roleLookup, RequireProjectAction(action, lookup, sm, resolve, handler))
}

// RequireProjectAction gates a project-scoped action: it authorises the caller
// against communityRoles(with per-project roles stripped) ∪ projectRoles(target
// project). A community-scope grant (Operations Steward / Founding Member, or
// any role the policy grants the capability community-wide) still passes on
// every project without a project lookup; a credential-derived project_lead /
// project_steward does NOT — only an actual assignment on the target project
// counts. Must run inside RBACMiddleware so the caller's community roles and AID
// are in context.
func RequireProjectAction(
	action contributions.Action,
	lookup ProjectRoleLookup,
	sm *anysync.SpaceManager,
	resolve ProjectIDResolver,
	next http.HandlerFunc,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		communityRoles := GetUserRoles(r)

		// Fast path: a genuine community-scope grant (project roles stripped so a
		// credential-derived lead/steward cannot satisfy it) already allows the
		// action on every project — skip the project lookup entirely.
		if contributions.CanPerformAction(contributions.StripProjectRoles(communityRoles), action) {
			next(w, r)
			return
		}

		spaceID := resolveCommunitySpaceID(r, sm)
		projectID, err := resolve(r, spaceID)
		if err != nil || projectID == "" {
			log.Printf("[RBAC] project-scoped %s denied: cannot resolve target project (id=%q err=%v)", action, projectID, err)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions"})
			return
		}

		var projectRoles []contributions.Role
		if lookup != nil {
			projectRoles = lookup.ProjectRoles(r.Context(), spaceID, projectID, GetUserAID(r))
		}
		if !contributions.CanPerformProjectAction(communityRoles, projectRoles, action) {
			log.Printf("[RBAC] access denied on project %s: action=%s community=%v project=%v", projectID, action, communityRoles, projectRoles)
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permissions"})
			return
		}
		next(w, r)
	}
}
