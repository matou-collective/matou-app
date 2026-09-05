package api

import (
	"net/http"

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
// amounts (holds view_contribution_amounts, or is the assignee) and a redacted
// copy otherwise. A nil lookup (RBAC disabled) returns c unchanged; the stored
// object is never mutated.
func visibleContributionAmounts(lookup RoleLookup, r *http.Request, c *contributions.Contribution) *contributions.Contribution {
	if lookup == nil || c == nil {
		return c
	}
	if contributions.CanViewContributionAmounts(GetUserRoles(r), GetUserAID(r), c) {
		return c
	}
	return contributions.RedactContributionAmounts(c)
}

// visibleContributionAmountsList applies visibleContributionAmounts to every
// contribution, returning a new slice (redacted elements are copies).
func visibleContributionAmountsList(lookup RoleLookup, r *http.Request, cs []*contributions.Contribution) []*contributions.Contribution {
	if lookup == nil {
		return cs
	}
	out := make([]*contributions.Contribution, len(cs))
	for i, c := range cs {
		out[i] = visibleContributionAmounts(lookup, r, c)
	}
	return out
}
