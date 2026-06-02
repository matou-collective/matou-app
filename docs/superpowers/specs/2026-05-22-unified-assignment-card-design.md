# Unified Assignment Card — Design

**Date:** 2026-05-22
**Status:** Draft

## Problem

Three related issues today:

1. **Sub-contributions bypass the offer/accept flow.** When a lead picks a contributor for a sub-contribution, the frontend calls `PUT /api/v1/contributions/{id}` with `assigned_contributor_id` set, then transitions the status. Top-level contributions go through `confirmed → offered → assigned` (the recipient explicitly accepts). Sub-contributions go directly to `assigned`. Two flows, two UI patterns, two mental models.

2. **The assignment UI is fragmented.** Top-level contributions use an "Assign Contribution" button at the bottom of `ContributionDetailBody` that opens a modal picker. Sub-contributions use a `sub-assign-panel` near the top with a "Change/Assign" button that opens the same modal with a flag. The edit dialog (`CreateContributionDialog`) has yet another arrangement (a separate Re-assign picker + an Unassign button), and only for top-levels. Same conceptual operation, four UI variants.

3. **Visible bug: stale assignee after unassign + re-offer.** After unassigning a contributor and offering the contribution to someone else, the UI sometimes shows both "Assigned to <original>" and "Offered to <new>". The backend's `OfferContribution` never clears `AssignedContributorID`; any code path that leaves a stale ID in place when status transitions to `offered` produces this visual.

## Goals

- One assignment workflow (`confirmed → offered → assigned`) for both top-level and sub-contributions.
- One UI component (`AssignmentCard`) appearing on every surface where a contribution is viewed or edited.
- Bug fix: `offered` state cannot show a stale `assigned_contributor`.

## Non-goals

- Reworking the rest of the contribution state machine (review, sign-off, reward, archive).
- Changing how RBAC gates these actions (still lead/steward/admin for offer/unassign).
- Touching the `share-with-group` flow or interested-contributors list.
- Backwards compatibility shims for the old direct-assign sub flow — once shipped, the old call sites are deleted.

## Behavior

### State table

| Contribution status | Card content | Primary action | Notes |
|---|---|---|---|
| `created` | Hidden — the body's existing "Confirm" button is the next step | — | Lead confirms first; card then renders in `confirmed` state |
| `confirmed`, `shared` (no assignee) | "No contributor assigned" subtitle | `Assign` button → opens existing modal picker | Member sees disabled state |
| `offered` | "Offered to {name} — awaiting acceptance", offered-at timestamp | `Re-offer` link → opens modal picker; selecting a member calls `/offer` and replaces the recipient | The standalone `offered-panel` in `ContributionDetailBody` is folded into this card |
| `assigned` | "Assigned to {name}", accepted-at timestamp if available | `Unassign` button. Clicking it reveals an inline search + member list directly in the card; selecting a member immediately calls `/offer` on the now-`confirmed` contribution | Two backend calls but one user action |
| `changed`, `needs_review`, `incomplete`, `approved`, `signed_off`, `rewarded`, `declined`, `archived` | Card renders read-only summary ("Assigned to {name}" or "Was assigned to {name}") | None | Card hides itself entirely for terminal statuses if the contribution has no assignee history |

### Action visibility (RBAC)

The card itself renders for everyone who can see the contribution. Action buttons render only when:

- **Assign** (status `confirmed`/`shared`, no assignee): caller has `ActionOfferContribution` (lead/steward/admin via existing `canOffer`).
- **Re-offer** (status `offered`): same as Assign — `canOffer` already accepts `offered` as a valid source state.
- **Unassign** (status `assigned`): caller has `ActionUnassignContribution` (lead/steward/admin).

Members viewing the card see read-only state.

### Sub-contribution propagation

When a parent contribution is accepted (`AcceptOffer` transitions parent to `assigned`), the existing `propagateAssigneeToChildren` is replaced with `propagateOfferToChildren`:

- Walk `parent.ChildContributionIDs`.
- For each child in status `created` with empty `AssignedContributorID`: call `OfferContribution(child, parent.AssignedContributorID, parent.AssignedContributorName)`. The child transitions to `offered`, recipient sees it in their offers inbox, can accept or decline.
- Children in any other status, or with an existing offer/assignee, are untouched.

The contributor accepting a parent contribution receives N child offers and can accept each independently.

### Bug fix

In `OfferContribution`, before assigning `OfferedTo`, clear `c.AssignedContributorID = ""`. This makes the `offered` state mutually exclusive from `assigned_contributor` regardless of how the function was called.

## Components

### New: `AssignmentCard.vue`

Location: `frontend/src/components/contributions/AssignmentCard.vue`

Props:
```ts
interface Props {
  contribution: Contribution;
  currentUserId?: string;
  canOffer: boolean;       // resolved by parent (uses useContributionWorkflow)
  canUnassign: boolean;    // resolved by parent
}
```

Emits:
```ts
{
  (e: 'offered', updated: Contribution): void;       // after successful /offer
  (e: 'unassigned', updated: Contribution): void;    // after successful /unassign
}
```

Internals:
- Reuses `MemberPicker` (existing component at `src/components/common/MemberPicker.vue`) for both the modal picker and the inline picker.
- Uses existing `useProfilesStore` for `id → displayName` lookup, with the same `status !== 'removed'` filter the other pickers use.
- Calls `contributionsStore.offer(id, { offered_to, offered_to_name })` and `contributionsStore.unassign(id)`. No new store actions needed.
- Local UI state: `showAssignModal: boolean`, `showInlinePicker: boolean` (becomes `true` after Unassign succeeds while the card is still mounted).

### Modified: `ContributionDetailBody.vue`

Remove:
- The `sub-assign-panel` block (lines ~61–87).
- The bottom "Assign Contribution" button (lines ~850–857).
- The standalone `offered-panel` block (lines ~89–99).
- `isSubAssignMode`, `openSubAssignDialog`, `submitSubAssign`, the `Assign Contribution` modal dialog block, and related local refs.

Add:
- Single `<AssignmentCard>` rendered once near the top of the body where the current sub-panel sits. The component decides what to show based on contribution status — no parent branching.
- `@offered` and `@unassigned` listeners that emit `update` upward, same shape the body already uses.

### Modified: `CreateContributionDialog.vue` (edit mode only)

Remove:
- `showReassignPicker` (lines ~510–522) and the picker markup that uses it.
- `showUnassignBlock` (lines ~524–532) and the button block (lines ~302–315).
- The `unassign` emit and `canUnassign` / `canReassign` props.

Add:
- `<AssignmentCard>` in edit mode, just above the Danger Zone block. Re-uses the same component instance pattern as the detail body.
- The dialog's "Save Changes" path remains unchanged for the rest of the form. Assignment changes happen through the card's own callbacks, not through the dialog's save button.

### Modified: composables

`useContributionWorkflow.ts`:
- `canOffer(c, role, isPlanSignedOff)` — drop the implicit "top-level only" assumption. Sub-contributions are eligible when status is `confirmed`/`shared`/`offered` and the user has lead/steward/admin role. The existing status check covers the rest.

`ContributionDetailBody.vue`:
- `canManageSubAssignment` is deleted (logic absorbed into `canOffer`/`canUnassign`).

### Backend: `OfferContribution`

```go
c.AssignedContributorID = ""        // NEW — defensive clear
c.OfferedTo = offeredTo
c.OfferedToName = offeredToName
c.OfferedAt = &now
c.AssignedContributorName = offeredToName
c.Status = ContribOffered
c.UpdatedAt = now
```

### Backend: `propagateOfferToChildren`

Replaces `propagateAssigneeToChildren`. Called from `AcceptOffer` after the parent's status update is saved.

```go
func (s *Service) propagateOfferToChildren(ctx context.Context, spaceID string, parent *Contribution) error {
    for _, childID := range parent.ChildContributionIDs {
        child, err := s.GetContribution(ctx, spaceID, childID)
        if err != nil {
            log.Printf("propagateOfferToChildren: skipping child %s (load error: %v)", childID, err)
            continue
        }
        if child.AssignedContributorID != "" || child.OfferedTo != "" {
            continue
        }
        // Only propagate to children that are still in the early lifecycle.
        // `created` needs a confirmation pass first; `confirmed` is offer-ready.
        if child.Status != ContribCreated && child.Status != ContribConfirmed {
            continue
        }
        if child.Status == ContribCreated {
            child.Status = ContribConfirmed
            if err := s.store.Save(spaceID, child.ID, "contribution", child); err != nil {
                return fmt.Errorf("propagateOfferToChildren: confirming child %s: %w", child.ID, err)
            }
        }
        if _, err := s.OfferContribution(ctx, spaceID, child.ID, parent.AssignedContributorID, parent.AssignedContributorName); err != nil {
            return fmt.Errorf("propagateOfferToChildren: offering child %s: %w", child.ID, err)
        }
    }
    return nil
}
```

The old `propagateAssigneeToChildren` is removed. `AssignContributor` (the direct-assign path) becomes unused for sub-contributions but is left in place for the lead's existing top-level "share with group" flow that doesn't go through `AcceptOffer`.

## Data flow

### Lead offers a sub-contribution
1. Lead opens contribution detail → sees `AssignmentCard` with "No contributor assigned".
2. Lead clicks `Assign` → modal opens with the member picker.
3. Lead picks Maraea → modal calls `contributionsStore.offer(id, { offered_to: "Maraea-aid", offered_to_name: "Maraea" })`.
4. Backend `OfferContribution` runs: clears `AssignedContributorID`, sets `OfferedTo`, `OfferedToName`, `OfferedAt`, `AssignedContributorName`, transitions to `offered`. Broadcasts SSE `contribution:assigned`. Notifies Maraea.
5. Frontend `_patch` updates the local contribution; card re-renders to "Offered to Maraea".

### Parent contribution accepted, children auto-offered
1. Contributor accepts parent contribution → `AcceptOffer` runs.
2. Parent transitions to `assigned`, saved.
3. `propagateOfferToChildren` walks children. For each child in `created` with no assignee/offer: confirms it, then offers it to the parent's contributor. SSE + notification per child.
4. Contributor's offer inbox shows the parent (already accepted) plus N new sub-offers.

### Lead unassigns and re-directs
1. Card shows "Assigned to Maraea". Lead clicks `Unassign`.
2. Frontend calls `contributionsStore.unassign(id)`. Backend clears assignee, status → `confirmed`. SSE `contribution:unassigned`.
3. `_patch` updates local state. Card re-renders to inline-picker mode (because `showInlinePicker` was set just before unassign).
4. Lead types in the search input, clicks Tyronne. Card calls `contributionsStore.offer(id, { offered_to: "Tyronne-aid", offered_to_name: "Tyronne" })`.
5. Backend now clears `AssignedContributorID` defensively (even though `unassign` already did), sets `OfferedTo` to Tyronne, transitions to `offered`. SSE + notification.
6. Card re-renders to "Offered to Tyronne". Bug eliminated.

## Testing

### Backend tests (go)

- `TestOfferContribution_ClearsAssignedContributorID` — set `AssignedContributorID` to a non-empty value on a `confirmed` contribution, call `OfferContribution`, assert ID is `""`.
- `TestPropagateOfferToChildren_OffersCreatedChildren` — parent with two `created` children, no children pre-assigned; accept parent; assert both children are `offered` with `OfferedTo == parent.AssignedContributorID`.
- `TestPropagateOfferToChildren_SkipsAlreadyAssignedChild` — one child already `assigned` to someone else; assert it is unchanged.
- `TestPropagateOfferToChildren_SkipsAlreadyOfferedChild` — one child already `offered`; assert it is unchanged.
- Existing `TestUnassignContribution_*` tests continue to pass unchanged.

### Frontend tests (vitest)

- `AssignmentCard.spec.ts`:
  - Renders nothing actionable when caller has neither `canOffer` nor `canUnassign`.
  - In `confirmed` state with `canOffer`: shows Assign button; clicking opens modal.
  - In `offered` state with `canOffer`: shows "Offered to X" + Re-offer link.
  - In `assigned` state with `canUnassign`: shows Unassign button; after click, inline picker appears.
  - Selecting a member from the inline picker calls `store.offer`.

### E2E tests (playwright)

- Extend `e2e-projects-contributions.spec.ts`:
  - Phase: lead offers a sub-contribution → recipient sees offer in inbox → recipient accepts → status transitions to assigned.
  - Phase: lead unassigns a top-level assigned contribution → offers to a different member → page shows only "Offered to {new}", no stale assignee.

## Migration

- Existing contributions in any status are unchanged on disk. Any `assigned` sub-contribution that was created via the old direct-assign path keeps its assignee — the new flow only affects new offers and parent-acceptance propagation.
- No data migration scripts needed.

## Open questions

None at design time. Implementation may surface details about the inline picker's height/animation on small screens that we'll tune during build.
