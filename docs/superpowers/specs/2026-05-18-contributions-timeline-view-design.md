# Contributions Timeline View — Design

**Date:** 2026-05-18
**Status:** Approved (ready for implementation plan)

## Context

The Contributions page (`/contributions`) currently renders one view: a flat card list (Mine + All sections, status + type filters, default sort by due date ascending — added in v0.2.1). Users planning ahead want to see *when* contributions are due relative to each other and to today, not just a flat list. Most also want overdue work surfaced at the top before they scan the rest.

## Goal

Add a Timeline view alongside the existing List view on the Contributions page. Users toggle between them; both share the same `Mine / All` filter and the same underlying contributions list. The timeline organises work into weekly columns with horizontal navigation and an Overdue section above.

## Non-goals

- No drag-to-reschedule, no card resize, no inline edit.
- No swimlanes-by-project (cards within a week are flat, sorted by due date).
- No standalone route — Timeline lives inside `/contributions` as a view-mode swap.
- No timeline view on the Projects page (out of scope; can copy the pattern later if useful).

## Surface

### Page layout (top → bottom)

1. Page heading + create button (existing).
2. **Mine / All** toggle (existing, unchanged).
3. **List | Timeline** view-mode segmented control (new). Persisted to `localStorage['matou:contributions:view']`; defaults to `list`.
4. Status + Type filter chips (existing) — visible only when view is `list`. Timeline drops them because it derives content purely from the deadline.
5. View body — either the existing list (`ContributionsListView`, the current page body) or `ContributionsTimelineView` (new).

### Mine / All semantics

Same as the list view today:

- **Mine**: contributions where `assigned_contributor_id` or `assigned_contributor` matches the current AID, OR `offered_to` matches the current AID. Excludes `archived`.
- **All**: all contributions in the community space except `archived`.

The timeline view inherits whichever the user has selected.

## Timeline view

### Data scope

Both sections derive from the contributions visible under the active Mine / All filter, with one extra rule: **contributions without a deadline are excluded from the timeline** (no place to put them). The List view still surfaces them.

### Overdue section (above the timeline)

- Header: `Overdue (N)` followed by an inline `Show / Hide` toggle when N > 6 (collapsed by default in that case to keep the page from being top-heavy).
- Definition: `deadline < startOfToday` AND status not in `{signed_off, rewarded, completed, archived}`.
- Layout: responsive CSS grid matching the existing Contributions/Proposals list — `repeat(3, 1fr)` at ≥1000px, 2 cols at ≥640px, 1 col below.
- Each card renders the **slim card** variant (see below) with the overdue deadline shown in red as a meta line.
- Sorted by deadline ascending (oldest overdue first).

### Weekly columns

- Three columns visible at once. Week definition: **Monday 00:00 local → Sunday 23:59 local**.
- Each column header shows the date range: `Mon 19 May – Sun 25 May`.
- The current week's column is visually highlighted (1px primary border + a small `Today` chip in the header).
- A `‹ Prev` button on the left and `Next ›` on the right shift the visible window by exactly one week per click.
- **Default visible window**: the week containing `today`, plus the two weeks after it (today's week sits in the leftmost column on first open).
- **Date bounds** for navigation:
  - `earliestWeek = startOfWeek(min(deadline ∪ today))` across the active contribution set (after the Mine/All filter; overdue contributions included, since stepping `Prev` to see the historic curve is useful).
  - `latestWeek = startOfWeek(max(deadline ∪ today))` across the same set.
  - Falling back to `today` on both ends guarantees the current week is always reachable, even if every contribution is in the past or every contribution is in the future.
  - `Prev` disabled when `windowStart <= earliestWeek`.
  - `Next` disabled when `windowStart >= latestWeek` (which means the visible window already ends at or beyond the latest week).
- Inside each column: vertical stack of slim cards, sorted by `deadline ASC` within the week.
- Empty column body: a centred muted `—` placeholder so the column still occupies space (prevents layout jitter).

### Card content (`ContributionSlimCard.vue`)

A new shared component used in both the overdue grid and the timeline columns.

```
┌──────────────────────────────────────────┐
│ Build login screen     [assigned]  ◉    │   ← title (ellipsis) · status pill · avatar
│ HRDAO                                   │   ← project name (muted)
│ Due 23/05  ⚠ overdue                    │   ← only shown in overdue grid (red)
└──────────────────────────────────────────┘
```

Fields:

- **Title**: 1 line, `text-overflow: ellipsis`.
- **Status pill**: existing `ContributionStatusBadge`.
- **Assignee avatar**: existing pattern from `ContributionCardCompact` — image if `profilesByAid[aid].avatar`, otherwise initials. Shows a tooltip with the assignee's display name. Hidden if the contribution has no assignee.
- **Project name**: looked up from `projectsStore.projects` by `contribution.project_id`. Muted text.
- **Overdue line** (overdue grid only): `Due {dd/mm/yyyy} · overdue` in `var(--matou-destructive)`. In the timeline columns this line is omitted because the column header already conveys the week.
- Hover: subtle border accent matching existing cards.
- Click: opens the existing `ContributionDetailDialog` (same component used elsewhere). Receives `contribution` plus the user-role/permission props the dialog already expects.

### Live updates

Existing global SSE handlers in `DashboardLayout.vue` already keep `contributionsStore.contributions` reactive on remote changes (assignments, accepts, declines, comment_added, generic `contribution_updated`). The timeline view derives everything from that store, so it picks up live updates without any new wiring.

## File layout

| Path | Purpose |
|------|---------|
| `frontend/src/components/contributions/ContributionSlimCard.vue` | Shared slim card (timeline + overdue). |
| `frontend/src/pages/Contributions/ContributionsTimelineView.vue` | Timeline body (overdue grid + 3-week strip + nav). |
| `frontend/src/pages/Contributions/ContributionsListView.vue` | (Optional refactor) Extract today's list body so `ContributionsPage` can swap between the two cleanly. If the in-place change is small enough, keep the list inside `ContributionsPage.vue`. |
| `frontend/src/pages/Contributions/ContributionsPage.vue` | Owns the Mine/All filter, the view-mode toggle, and mounts the active view. |
| `frontend/src/lib/weekRange.ts` | Pure helpers: `startOfWeek(d)`, `endOfWeek(d)`, `addWeeks(d, n)`, `weeksBetween(a, b)`. Mon-start. Used by the timeline view and tested in isolation. |

No backend changes. No new endpoints. No store changes — reuses `contributionsStore.contributions`, `projectsStore.projects`, `profilesStore.profilesByAid`.

## State

`ContributionsPage` holds:

- `viewMode: 'list' | 'timeline'` — persisted to `localStorage['matou:contributions:view']`.

`ContributionsTimelineView` holds:

- `windowStart: Date` — Monday of the leftmost visible week. Initialised to `startOfWeek(today)`.
- Computed `visibleWeeks`: `[windowStart, addWeeks(windowStart, 1), addWeeks(windowStart, 2)]`.
- Computed `bucketed`: `Map<weekStartISO, Contribution[]>` — derived once from the input contributions; cards in each bucket sorted by `deadline ASC`.
- Computed `overdue`: contributions with `deadline < startOfToday` and active status.
- Computed `canPrev` / `canNext` from the date bounds described above.

## Edge cases

- **No deadlines at all** (every contribution missing a due date): show an empty-state message `No timeline yet — add due dates to your contributions to see them here.` and hide the column strip.
- **All contributions in one week**: visible window still shows three columns; the populated one renders, the other two show `—`.
- **Single contribution overdue**: overdue header reads `Overdue (1)`; collapse toggle hidden.
- **Comment unread + offered badges**: the slim card stays minimal — no badges on it. If we want the unread red circle later we can copy the pattern from `ContributionCard.vue`, but the design intentionally keeps the timeline cards quiet so users can scan them.

## Open questions

None — all major decisions confirmed during brainstorming.

## Verification

- TS clean (baseline 22, no new errors).
- View toggle persists across reloads.
- Mine + Timeline shows only the current user's contributions; All + Timeline shows everyone's.
- Prev/Next can always reach today's week even when the dataset is in the past.
- Posting a comment / accepting an offer in another session refreshes the relevant card in the timeline via the existing SSE pipeline.
- Overdue auto-collapses at N > 6.
