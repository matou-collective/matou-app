package api

import (
	"net/http"

	"github.com/matou-dao/backend/internal/anysync"
	"github.com/matou-dao/backend/internal/contributions"
)

// Contribution-amount visibility (#314). Reads of contributions strip the
// budget/actuals fields from callers who neither hold view_contribution_amounts
// nor are the assigned contributor. These free helpers are shared by the
// contributions and projects handlers; each handler wires them against its own
// RoleLookup (nil in unit tests, which disables stripping).

// optionalRBAC wraps handler with OptionalRBACMiddleware when lookup is non-nil,
// so a read handler sees the caller's AID/roles in context without rejecting an
// anonymous request. A nil lookup (tests) passes the handler through untouched.
func optionalRBAC(lookup RoleLookup, handler http.HandlerFunc) http.HandlerFunc {
	if lookup == nil {
		return handler
	}
	return OptionalRBACMiddleware(lookup, handler)
}

// visibleContributionAmounts returns c unchanged when the caller may see its
// amounts and a redacted copy otherwise. The view_contribution_amounts
// capability is resolved PER PROJECT (#373): the caller's community roles (with
// per-project roles stripped) plus the roles they actually hold on c's owning
// project, so a credential-derived project_steward/lead does not reveal amounts
// on every project — only an assignment on that project does. The assignee
// always sees their own amounts. A nil lookup (RBAC disabled) returns c
// unchanged; the stored object is never mutated.
func visibleContributionAmounts(lookup RoleLookup, projectRoles ProjectRoleLookup, sm *anysync.SpaceManager, r *http.Request, c *contributions.Contribution) *contributions.Contribution {
	if lookup == nil || c == nil {
		return c
	}
	callerAID := GetUserAID(r)
	var pr []contributions.Role
	if projectRoles != nil && c.ProjectID != "" && callerAID != "" {
		pr = projectRoles.ProjectRoles(r.Context(), resolveCommunitySpaceID(r, sm), c.ProjectID, callerAID)
	}
	if contributions.CanViewContributionAmountsInProject(GetUserRoles(r), pr, callerAID, c) {
		return c
	}
	return contributions.RedactContributionAmounts(c)
}

// visibleContributionAmountsList applies visibleContributionAmounts to every
// contribution, returning a new slice (redacted elements are copies).
func visibleContributionAmountsList(lookup RoleLookup, projectRoles ProjectRoleLookup, sm *anysync.SpaceManager, r *http.Request, cs []*contributions.Contribution) []*contributions.Contribution {
	if lookup == nil {
		return cs
	}
	out := make([]*contributions.Contribution, len(cs))
	for i, c := range cs {
		out[i] = visibleContributionAmounts(lookup, projectRoles, sm, r, c)
	}
	return out
}
