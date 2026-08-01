# Rewarded Chip in Contributions List — Design

**Date:** 2026-07-31
**Scope:** `frontend/src/pages/Contributions/ContributionsPage.vue` only

## Problem

Rewarded contributions (terminal status) currently appear in the default "All"
and "Mine" views of the contributions list, cluttering active work. Archived
contributions are already hidden from those views and given their own filter
chip; rewarded should get the same treatment.

## Design

1. **New scope filter `rewarded`** added to the chip row, placed after
   "Signed Off": All, Mine, Open, Assigned, In Review, Signed Off, Rewarded,
   Archived. It filters to `status === 'rewarded'` exactly and is a valid
   persisted scope in localStorage (`matou:contributions:scope`).
2. **Signed Off chip narrows** to `status === 'signed_off'` only. The
   `SIGNED_OFF_STATUSES` set is removed.
3. **All hides rewarded** — same treatment as archived, since rewarded now has
   its own chip.
4. **Mine excludes rewarded** — same as it excludes archived today.

## Out of scope

No backend, store, or card-component changes. Type filter and sorting are
unchanged. No new tests: the page's filter logic is inline and untested today;
extracting it for testing is not part of this change.
