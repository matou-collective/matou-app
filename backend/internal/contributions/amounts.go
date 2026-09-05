package contributions

// Amount-visibility rules for contributions (#314). A contribution's monetary
// fields — the estimated Budget and the recorded ActualCost — are only exposed
// to callers who are entitled to see them. Entitlement is either role-based (the
// view_contribution_amounts capability) or resource-level (you are the assigned
// contributor on that contribution, so its amounts are always yours to see).

// CanViewContributionAmounts reports whether a caller may see the budget and
// actual-cost amounts on a contribution. Amounts are visible when the caller is
// the assigned contributor on that contribution, or their roles grant
// view_contribution_amounts under the current policy.
func CanViewContributionAmounts(roles []Role, callerAID string, c *Contribution) bool {
	if c == nil {
		return false
	}
	if callerAID != "" && c.AssignedContributorID == callerAID {
		return true
	}
	return CurrentPolicy().HasCapability(roles, CapViewContributionAmounts)
}

// RedactContributionAmounts returns a shallow copy of c with the budget and
// actual-cost fields cleared, leaving the stored/shared object untouched. Nil in,
// nil out.
func RedactContributionAmounts(c *Contribution) *Contribution {
	if c == nil {
		return nil
	}
	cp := *c
	cp.Budget = ""
	cp.ActualCost = 0
	return &cp
}
