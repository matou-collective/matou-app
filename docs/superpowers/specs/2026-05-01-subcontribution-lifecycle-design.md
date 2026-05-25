# Sub-Contribution Lifecycle Unification — Design

**Date:** 2026-05-01
**Status:** Approved (ready for implementation plan)

## Context

Today, top-level contributions and sub-contributions follow divergent lifecycles:

- **Top-level**: `created → confirmed → {shared, offered} → assigned → … → signed_off`
  Confirmation is gated by admin/steward; sharing/offering/interest registration brings new contributors in.
- **Sub-contribution**: `created → assigned` via the dedicated `POST /approve-sub` endpoint, which auto-assigns the parent's contributor and skips confirmed/shared/offered.

This worked when subs were assumed to be the assigned contributor "breaking their own work into pieces." It breaks down for the second valid use case: **a contributor wanting help from someone else on part of their work**. Today there is no way to make a sub assigned to a different contributor.

The original design intent (`docs/design/CONTRIBUTIONS_UX_FLOWS.md` §5) was for subs to follow the normal lifecycle. The `approve-sub` shortcut diverged from that.

## Goal

Subs share the **same state machine** as top-level contributions, with one difference: subs skip the planning-only states (`confirmed`, `shared`, `offered`). Subs can be assigned to **any community member**, not just the parent's assignee. The contributor is picked at creation time and can be edited before approval.

## Non-goals

- No share/offer/interest flow for subs.
- No plan-level confirmation gate for subs.
- No nested subs (flat hierarchy preserved).
- No data migration of existing subs.

## State machine

| Transition | Top-level | Sub |
|---|---|---|
| Initial | `created → confirmed → {shared,offered} → assigned` | `created → assigned` |
| Re-approval after lead edit | `assigned → changed → confirmed/assigned` | `assigned → changed → assigned` |
| Review | `assigned → needs_review → {approved, incomplete, declined}` | identical |
| Completion | `approved → signed_off → rewarded → archived` | identical |

The backend transition table (`backend/internal/contributions/validation.go`) already permits `created → assigned`. Re-approval after `changed` only needs the existing `changed → assigned` transition, which is also already permitted.

## Contributor selection (at creation, editable before approval)

- **At creation:** `CreateContributionDialog.vue`, when `parentContributionId` is set, gains a contributor picker. Default value: parent's `assigned_contributor_id`. Creator can change to any community member or clear it.
- **Storage while in `created` state:** the chosen contributor lives in the existing `Contribution.assigned_contributor_id` field (already nullable). No new fields.
- **At approval:** no picker, no override. Approve uses whatever contributor is set on the sub.
- **If no contributor is set:** Approve is disabled with a tooltip ("Assign a contributor first"). Lead/admin must Edit the sub to set one before they can Approve.
- **Editing a `created` sub:** stays in `created` (no re-approval loop — pre-approval edits are free).
- **Editing an `assigned` sub:** existing rule applies — lead-edit transitions to `changed`, requires re-approval.

## Plan sign-off (independent, current behavior preserved)

- Plan sign-off check looks at top-level contributions only. Subs in `created` do not block sign-off.
- Subs created post-sign-off do not trigger plan re-signoff.

## Authority (unchanged)

| Action | Roles |
|---|---|
| Create sub | parent's assignee, project lead, project steward, community admin |
| Approve sub | project lead, community admin |
| Edit sub | project lead, project steward, community admin |
| Archive sub | project lead, project steward, community admin |

## Backend changes

### `ApproveSubContribution` (`backend/internal/contributions/service.go`)

```go
func (s *Service) ApproveSubContribution(ctx context.Context, spaceID, contributionID string) (*Contribution, error) {
    child, err := s.GetContribution(ctx, spaceID, contributionID)
    if err != nil { return nil, err }
    if child.ParentContributionID == "" {
        return nil, fmt.Errorf("contribution %s is not a sub-contribution (no parent)", contributionID)
    }
    if child.Status != ContribCreated {
        return nil, fmt.Errorf("sub-contribution must be in created status to approve, current: %s", child.Status)
    }
    // NEW: require explicit assignee. The parent-fallback is removed.
    if child.AssignedContributorID == "" {
        return nil, fmt.Errorf("sub-contribution must have an assigned contributor before approval")
    }
    if err := ValidateContributionTransition(child.Status, ContribAssigned); err != nil {
        return nil, err
    }
    child.Status = ContribAssigned
    child.UpdatedAt = time.Now()
    if err := s.store.Save(spaceID, child.ID, "contribution", child); err != nil {
        return nil, err
    }
    return child, nil
}
```

### `CreateContribution`

No structural change. The handler already accepts `assigned_contributor_id` on `CreateContributionRequest`; ensure it's persisted on the sub when supplied. Verify field is wired through service → model → storage.

### Re-approval after lead edit

Add a small extension to `ApproveSubContribution` (or a sibling method) to accept `changed → assigned` as a valid source state for subs. Implementation note: the simplest path is to relax the guard in `ApproveSubContribution` from `child.Status != ContribCreated` to `child.Status != ContribCreated && child.Status != ContribChanged`, and validate the corresponding transition.

### API contract

`POST /api/v1/contributions/:id/approve-sub` — payload unchanged (no body). Backward-compatible. Behavior change: returns `400` if the sub has no `assigned_contributor_id` set.

## Frontend changes

### `CreateContributionDialog.vue`

- When `parentContributionId` is set, render a contributor picker.
- Default value: parent's `assigned_contributor_id` (look up via prop or store).
- Picker source: community members (use `useProfilesStore` profiles list, filtered by space).
- On submit, include `assigned_contributor_id` in the create payload.

### `useContributionWorkflow.canApproveSub`

Gain a precondition check:

```ts
function canApproveSub(contribution: Contribution, role: ProjectRole | string): boolean {
  return (
    !!contribution.parent_contribution &&
    !!contribution.assigned_contributor_id &&  // NEW
    (contribution.status === 'created' || contribution.status === 'changed') &&  // NEW: re-approval support
    _isRole(role, LEAD_ROLES)
  );
}
```

### Approve UI

- `ContributionDetailDialog.vue` sub-list rows: bind `:disable="!canApproveSubFor(child)"` on the Approve button. Tooltip when disabled: "Assign a contributor first."
- `ContributionCardCompact.vue` (milestone collapsible section, sub case): same disabled binding.
- Show the suggested contributor avatar/name on each row so leads can see at a glance who would be assigned on Approve.

### `contributionsStore.approveSub`

Signature unchanged: `approveSub(id: string)`. No payload extension.

## Backward compatibility

- Existing subs already in `assigned` state: untouched. Their `assigned_contributor_id` is the parent's (set by the old `approve-sub` overwrite).
- Existing subs in `created` state with no `assigned_contributor_id`: lead must edit them (via the existing Edit action) to set a contributor before Approve becomes enabled. The picker default (parent's contributor) makes this a one-click fix.
- API consumers calling `POST /approve-sub` against a sub without an assignee: receive a `400` with a clear error message. No silent auto-assignment.
- The current "auto-inherit parent's contributor at approve time" behavior is removed in favor of explicit assignment captured at creation. The picker default keeps the typical UX unchanged for the "break my work into pieces" case.

## Risks and verification

- **Top-level reuse of the create dialog:** the contributor picker must only appear when `parentContributionId` is set. Top-level contributions in `created` state are still assigned later via share/offer/interest, not at creation.
- **Profile picker source:** confirm `useProfilesStore` exposes a list of community members usable in a `q-select`. If not, add a small computed.
- **Re-approval transition guard:** confirm the backend transition table allows `changed → assigned`. (Per `validation.go:59`, it does — `ContribChanged: {ContribConfirmed, ContribAssigned}`.)
- **Existing tests:** any test that relies on `approve-sub` auto-assigning the parent's contributor will fail. These need to be updated to either set `assigned_contributor_id` first, or be rewritten to reflect the new contract.

## Open implementation choices (resolve when writing the plan)

- Picker UX: `q-select` with autocomplete vs. a search/typeahead component used elsewhere — pick whatever already exists.
- Lead-side edit-before-approve UX: rely on the existing Edit button on the sub-list row, or add an inline "Change assignee" shortcut. Default: rely on existing Edit.
