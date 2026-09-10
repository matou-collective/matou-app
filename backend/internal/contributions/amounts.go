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

// CanViewContributionAmountsInProject is the project-scoped form of
// CanViewContributionAmounts (#373). The view_contribution_amounts capability is
// resolved against the caller's community roles (per-project roles stripped) ∪
// the roles they actually hold on the contribution's project, mirroring
// CanPerformProjectAction for write actions (#166). A credential-derived
// project_lead / project_steward therefore no longer reveals amounts on every
// project — only an assignment on the target project does — while community-scope
// grants of the capability (e.g. a custom community role) still apply everywhere.
// The assigned contributor always sees their own contribution's amounts.
func CanViewContributionAmountsInProject(communityRoles, projectRoles []Role, callerAID string, c *Contribution) bool {
	if c == nil {
		return false
	}
	if callerAID != "" && c.AssignedContributorID == callerAID {
		return true
	}
	return CurrentPolicy().HasCapability(ProjectScopedRoles(communityRoles, projectRoles), CapViewContributionAmounts)
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
