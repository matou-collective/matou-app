package contributions

import (
	"context"
	"fmt"
)

// Derived "M.C.S" contribution references (issue #753).
//
// A reference locates a contribution by position, without being part of its
// title text:
//
//	M = the milestone's 1-based position within its implementation plan
//	C = the contribution's 1-based position among its milestone's top-level
//	    (parent-less) contributions
//	S = 0 for a top-level contribution, else its 1-based position among its
//	    parent's children
//
// So milestone 1's second contribution is "1.2.0", and that contribution's
// first and second sub-contributions are "1.2.1" and "1.2.2". The reference is
// derived from order — never stored — so reordering siblings (issue #754)
// renumbers them for free, with no migration. Positions follow the canonical
// sibling order (explicit sort_order, then a numeric-aware title sort; see
// ordering.go), with archived siblings numbered after the active ones so the
// active references stay gap-free for readers.

// orderGroupForReference returns one sibling group in the order used for
// numbering: non-archived siblings first (in canonical sibling order), then
// archived siblings (same order) appended after. Keeping archived siblings out
// of the active run is what makes the active references contiguous (1.1.0,
// 1.2.0, …) with no gap to puzzle over, while an archived sibling still gets a
// stable, correctly-derived reference past the end of the active run.
func orderGroupForReference(group []*Contribution) []*Contribution {
	active := make([]*Contribution, 0, len(group))
	var archived []*Contribution
	for _, c := range group {
		if c == nil {
			continue
		}
		if c.Status == ContribArchived {
			archived = append(archived, c)
		} else {
			active = append(active, c)
		}
	}
	SortSiblings(active)
	SortSiblings(archived)
	return append(active, archived...)
}

// orderedMilestonesForReference returns the plan's milestones in reference-
// numbering order: non-archived milestones first in their stored order, then
// archived ones. Milestones carry no explicit sort order, so stored (creation)
// order is their canonical order; pushing archived milestones last keeps the
// active milestone numbers (1, 2, 3, …) contiguous.
func orderedMilestonesForReference(plan *ImplementationPlan) []*Milestone {
	active := make([]*Milestone, 0, len(plan.Milestones))
	var archived []*Milestone
	for i := range plan.Milestones {
		ms := &plan.Milestones[i]
		if ms.Status == MilestoneArchived {
			archived = append(archived, ms)
		} else {
			active = append(active, ms)
		}
	}
	return append(active, archived...)
}

// derivePlanReferences computes the "M.C.S" reference for every contribution
// reachable from plan and writes it into out (keyed by contribution ID). byID
// resolves a milestone's / parent's child IDs to the full contribution record,
// because milestones and parents store only IDs. A nil or missing id is
// skipped. See the package-level documentation above for the format.
func derivePlanReferences(plan *ImplementationPlan, byID map[string]*Contribution, out map[string]string) {
	for mi, ms := range orderedMilestonesForReference(plan) {
		m := mi + 1
		tops := make([]*Contribution, 0, len(ms.ContributionIDs))
		for _, cid := range ms.ContributionIDs {
			c := byID[cid]
			// Only genuine top-level contributions are numbered at this level;
			// a sub-contribution that also carries a milestone_id is numbered
			// under its parent instead, so skip it here to avoid double counting.
			if c == nil || c.ParentContributionID != "" {
				continue
			}
			tops = append(tops, c)
		}
		for ci, c := range orderGroupForReference(tops) {
			cNum := ci + 1
			out[c.ID] = fmt.Sprintf("%d.%d.0", m, cNum)
			kids := make([]*Contribution, 0, len(c.ChildContributionIDs))
			for _, kid := range c.ChildContributionIDs {
				if k := byID[kid]; k != nil {
					kids = append(kids, k)
				}
			}
			for si, k := range orderGroupForReference(kids) {
				out[k.ID] = fmt.Sprintf("%d.%d.%d", m, cNum, si+1)
			}
		}
	}
}

// ReferencesForProject returns id→"M.C.S" for every contribution in projectID,
// derived from the project's implementation plans (see derivePlanReferences).
func (s *Service) ReferencesForProject(ctx context.Context, spaceID, projectID string) (map[string]string, error) {
	plans, err := s.ListImplementationPlans(ctx, spaceID)
	if err != nil {
		return nil, err
	}
	contribs, err := s.ListContributionsByProject(ctx, spaceID, projectID)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*Contribution, len(contribs))
	for _, c := range contribs {
		byID[c.ID] = c
	}
	out := make(map[string]string, len(contribs))
	for _, plan := range plans {
		if plan.ProjectID != projectID {
			continue
		}
		derivePlanReferences(plan, byID, out)
	}
	return out, nil
}

// StampReferences sets Reference on each contribution to its derived "M.C.S"
// value. Contributions are grouped by project so each project's plans are read
// once. Best-effort: a project whose references cannot be computed leaves its
// contributions' Reference empty rather than failing the read. Call it on the
// exact objects about to be serialized, after any amount-redaction copy.
func (s *Service) StampReferences(ctx context.Context, spaceID string, contribs []*Contribution) {
	byProject := map[string][]*Contribution{}
	for _, c := range contribs {
		if c == nil {
			continue
		}
		byProject[c.ProjectID] = append(byProject[c.ProjectID], c)
	}
	for projectID, list := range byProject {
		refs, err := s.ReferencesForProject(ctx, spaceID, projectID)
		if err != nil {
			continue
		}
		for _, c := range list {
			if ref, ok := refs[c.ID]; ok {
				c.Reference = ref
			}
		}
	}
}
