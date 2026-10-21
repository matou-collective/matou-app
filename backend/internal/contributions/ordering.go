package contributions

import (
	"context"
	"fmt"
	"sort"
	"time"
	"unicode"
)

// naturalLess reports whether title a should sort before title b using a
// numeric-aware ("natural") comparison, so e.g. "1.2.9" sorts before "1.2.10"
// rather than lexicographically after it. Runs of digits are compared by
// numeric value; everything else is compared rune-by-rune, case-insensitively,
// with the original form breaking ties so the order stays deterministic.
func naturalLess(a, b string) bool {
	ar, br := []rune(a), []rune(b)
	i, j := 0, 0
	for i < len(ar) && j < len(br) {
		if unicode.IsDigit(ar[i]) && unicode.IsDigit(br[j]) {
			// Measure each digit run (skipping leading zeros for the value
			// comparison, but keeping length so "01" vs "1" stays stable).
			is, js := i, j
			for i < len(ar) && unicode.IsDigit(ar[i]) {
				i++
			}
			for j < len(br) && unicode.IsDigit(br[j]) {
				j++
			}
			na := trimLeadingZeros(ar[is:i])
			nb := trimLeadingZeros(br[js:j])
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			for k := 0; k < len(na); k++ {
				if na[k] != nb[k] {
					return na[k] < nb[k]
				}
			}
			// Equal numeric value: shorter original (fewer leading zeros) first.
			if (i - is) != (j - js) {
				return (i - is) < (j - js)
			}
			continue
		}
		ca, cb := unicode.ToLower(ar[i]), unicode.ToLower(br[j])
		if ca != cb {
			return ca < cb
		}
		i++
		j++
	}
	if len(ar)-i != len(br)-j {
		return len(ar)-i < len(br)-j
	}
	// Fully equal under the case-insensitive natural comparison: fall back to
	// the raw strings so the order is total and deterministic.
	return a < b
}

func trimLeadingZeros(r []rune) []rune {
	k := 0
	for k < len(r)-1 && r[k] == '0' {
		k++
	}
	return r[k:]
}

// lessSibling is the canonical sibling ordering used everywhere contributions
// are listed. Contributions with an explicit SortOrder are the source of
// truth; contributions without one (created before ordering existed) fall back
// to a numeric-aware title sort and sort ahead of the explicitly-ordered ones.
// Placing unordered-before-ordered is what makes a freshly created
// contribution — which is assigned the next order at the end of the existing
// explicit positions — land at the end of a legacy, title-sorted list.
func lessSibling(a, b *Contribution) bool {
	ao, bo := a.SortOrder, b.SortOrder
	switch {
	case ao == nil && bo == nil:
		return naturalLess(a.Title, b.Title)
	case ao == nil:
		return true // unordered sorts before ordered
	case bo == nil:
		return false
	case *ao != *bo:
		return *ao < *bo
	default:
		return naturalLess(a.Title, b.Title)
	}
}

// SortSiblings sorts a group of sibling contributions in place into their
// canonical display order (see lessSibling). The input must be a single
// sibling group — a milestone's top-level contributions or one parent's
// children — so that SortOrder values are comparable.
func SortSiblings(cs []*Contribution) {
	sort.SliceStable(cs, func(i, j int) bool { return lessSibling(cs[i], cs[j]) })
}

// SortContributionsStable orders a flat, cross-group list (e.g. a whole
// project's contributions) deterministically: grouped by milestone, then by
// parent, then by canonical sibling order within each group. Flat consumers
// re-group and re-sort client-side, so this only needs to be stable and
// sensible rather than globally meaningful — it replaces the arbitrary object
// store iteration order.
func SortContributionsStable(cs []*Contribution) {
	sort.SliceStable(cs, func(i, j int) bool {
		a, b := cs[i], cs[j]
		if a.MilestoneID != b.MilestoneID {
			return a.MilestoneID < b.MilestoneID
		}
		if a.ParentContributionID != b.ParentContributionID {
			return a.ParentContributionID < b.ParentContributionID
		}
		return lessSibling(a, b)
	})
}

// nextSortOrder returns the SortOrder to assign to a new contribution so it
// lands at the end of its sibling group: one past the highest explicit order
// among the existing siblings, or 0 when none carry an explicit order.
func (s *Service) nextSortOrder(ctx context.Context, spaceID string, siblingIDs []string) int {
	maxOrder := -1
	for _, id := range siblingIDs {
		c, err := s.GetContribution(ctx, spaceID, id)
		if err != nil || c.SortOrder == nil {
			continue
		}
		if *c.SortOrder > maxOrder {
			maxOrder = *c.SortOrder
		}
	}
	return maxOrder + 1
}

// ReorderContributions assigns contiguous SortOrder positions to a sibling
// group according to orderedIDs. representativeID is any contribution in the
// target group (its path-resolved project is already RBAC-checked by the
// caller); the group is derived from it: a sub-contribution's parent's
// children, otherwise a milestone's top-level contributions. orderedIDs must be
// a permutation of the group's non-archived contributions — any add, drop, or
// id from a different group is rejected, which is what confines a drag to
// within one milestone / one parent. The reorder is recorded on the owning
// plan's change log; sign-off is deliberately left intact, as ordering is
// presentational and changes no contribution's content.
func (s *Service) ReorderContributions(ctx context.Context, spaceID, representativeID string, orderedIDs []string, actorID string) ([]*Contribution, error) {
	rep, err := s.GetContribution(ctx, spaceID, representativeID)
	if err != nil {
		return nil, fmt.Errorf("load contribution: %w", err)
	}

	// Resolve the sibling group's full id set.
	var siblingIDs []string
	if rep.ParentContributionID != "" {
		parent, err := s.GetContribution(ctx, spaceID, rep.ParentContributionID)
		if err != nil {
			return nil, fmt.Errorf("load parent: %w", err)
		}
		siblingIDs = parent.ChildContributionIDs
	} else if rep.MilestoneID != "" {
		ms, err := s.GetMilestone(ctx, spaceID, rep.MilestoneID)
		if err != nil {
			return nil, fmt.Errorf("load milestone: %w", err)
		}
		siblingIDs = ms.ContributionIDs
	} else {
		return nil, fmt.Errorf("contribution %s has no milestone or parent to reorder within", representativeID)
	}

	// The reorder operates over the non-archived siblings (what viewers see).
	visible := map[string]*Contribution{}
	for _, id := range siblingIDs {
		c, err := s.GetContribution(ctx, spaceID, id)
		if err != nil || c.Status == ContribArchived {
			continue
		}
		visible[id] = c
	}

	// orderedIDs must be exactly a permutation of the visible sibling set: no
	// adds, no drops, no ids from another group.
	if len(orderedIDs) != len(visible) {
		return nil, fmt.Errorf("reorder list has %d ids, expected %d siblings", len(orderedIDs), len(visible))
	}
	seen := map[string]bool{}
	for _, id := range orderedIDs {
		if _, ok := visible[id]; !ok {
			return nil, fmt.Errorf("contribution %s is not a reorderable sibling of %s", id, representativeID)
		}
		if seen[id] {
			return nil, fmt.Errorf("contribution %s appears more than once in the reorder list", id)
		}
		seen[id] = true
	}

	// Assign contiguous positions and persist.
	reordered := make([]*Contribution, 0, len(orderedIDs))
	for i, id := range orderedIDs {
		pos := i
		c := visible[id]
		c.SortOrder = &pos
		if err := s.SaveContribution(ctx, spaceID, c); err != nil {
			return nil, fmt.Errorf("save contribution %s: %w", id, err)
		}
		reordered = append(reordered, c)
	}

	s.recordReorder(ctx, spaceID, rep, actorID)
	return reordered, nil
}

// recordReorder appends a contribution_reordered entry to the owning plan's
// change log so plan history shows the reorder. Best-effort: a failure to
// resolve or save the plan does not fail the reorder itself, mirroring the
// create path's handling of the change log. Sign-off is intentionally not
// invalidated — reordering changes presentation, not plan content.
func (s *Service) recordReorder(ctx context.Context, spaceID string, rep *Contribution, actorID string) {
	msID, msTitle, parentID, parentTitle := s.ResolvePlanChangeRefs(ctx, spaceID, rep)
	if msID == "" {
		return
	}
	plan, _, err := s.findMilestone(ctx, spaceID, msID)
	if err != nil {
		return
	}
	appendPlanChange(plan, PlanChangeEntry{
		Kind:                    "contribution_reordered",
		MilestoneID:             msID,
		MilestoneTitle:          msTitle,
		ParentContributionID:    parentID,
		ParentContributionTitle: parentTitle,
		ChangedBy:               actorID,
	})
	plan.UpdatedAt = time.Now()
	_ = s.SaveImplementationPlan(ctx, spaceID, plan)
}
