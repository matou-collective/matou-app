# Contributions System Updates — Design

**Date:** 2026-04-28
**Branch:** `feature/contributions`
**Status:** Approved (awaiting user spec review)

## Summary

Five updates to the contributions system:

1. Delete (archive) a project with cascading archive of plan, milestones, contributions, and sub-contributions, gated by a typed `DESTROY` confirmation.
2. Edit and delete (archive) milestones, contributions, and sub-contributions, with cascading archive on parent deletion and a basic confirmation dialog.
3. Allow project lead, steward, or community admin to unassign a contributor through the contribution edit screen; status reverts to `confirmed` and `assigned_contributor_id` is cleared.
4. Lead-initiated "submit project complete" flow with steward signoff via a new `pending_completion` project status.
5. Standardize input heights across contribution and proposal forms by using `type="textarea" autogrow` for objectives, deliverables, and acceptance criteria.

## Goals & Non-Goals

**Goals**

- Give project leads, stewards, and admins authoritative control over project/contribution lifecycle (delete, edit, unassign, completion signoff).
- Use existing patterns (`status` enum transitions, RBAC actions, Quasar dialogs, Pinia stores) rather than introducing new architectural concepts.
- Keep cascade semantics uniform: every entity in the hierarchy supports `status='archived'`.

**Non-Goals**

- No audit log / history of unassign or archive events (out of scope; can be added later).
- No restoring (un-archiving) entities through the UI in this round — the data is preserved (status flip, not row delete) so a future restore feature is unblocked, but no UI for it now.
- No notification / email surface for "submit project complete" — the steward sees the request via project status changing in the UI.
- No reshape of the existing schema beyond adding two enum values.

## Existing Context (verified)

- **Frontend types** at `frontend/src/types/projects.ts`:
  - `ProjectStatus = 'created' | 'active' | 'completed' | 'archived'`
  - `ContributionStatus` already includes `'archived'` and `'confirmed'`
  - `MilestoneStatus = 'planned' | 'in_progress' | 'completed' | 'delayed'` (no `archived`)
  - `PlanStatus` already includes `'archived'`
- **Backend models** at `backend/internal/contributions/models.go` mirror these.
- **Permission helper** `frontend/src/composables/useProjectPermissions.ts` exposes `isAdmin`, `isSteward`, `isLead`, `canEditProject`, etc.
- **Backend RBAC** `backend/internal/contributions/roles.go` defines `Action*` constants and per-role permission maps; API handlers call `RequireAction()` middleware.
- **Forms**:
  - `frontend/src/components/projects/ProjectForm.vue` (project edit)
  - `frontend/src/components/contributions/ContributionForm.vue` (contribution create/edit; will be reused for sub-contributions)
  - `frontend/src/components/projects/AddMilestoneDialog.vue` (milestone create; will become `MilestoneFormDialog.vue` with a `mode` prop)
  - `frontend/src/components/proposals/CreateProposalDialog.vue` (proposal create; reference for textarea autogrow pattern)
- **Existing dialog pattern**: simple Quasar `q-dialog` with confirm/cancel buttons (e.g., `ContributionDetailDialog.vue`'s offer-confirmation dialog). No typed-confirmation pattern exists yet.
- **Contribution edit is not currently wired up** in the UI; entry points (pencil icons) need to be added as part of item 2.

---

## 1. Delete project (archive cascade)

### Backend

**New endpoint**

```
POST /api/v1/projects/:id/archive
```

- RBAC: `ActionArchiveProject` (admin, steward, lead)
- Behavior: in a single transaction, set:
  - `project.status = 'archived'`
  - `implementation_plan.status = 'archived'` (if exists)
  - All `milestones[*].status = 'archived'`
  - All `contributions[*].status = 'archived'` (recursive on `parent_id` to include sub-contributions)
- Returns the updated project. On failure, the transaction rolls back; no partial archive.

**New action constant**

- `ActionArchiveProject` added to `backend/internal/contributions/roles.go`, mapped to admin/steward/lead.

### Frontend

**Project edit page** (`ProjectForm.vue`)

- Add a "Danger Zone" section at the bottom (visible only in edit mode and when `canEditProject`).
- Single button: "Delete Project" (red/negative styling).
- Click opens `ConfirmDestroyDialog.vue` (new, reusable).

**`ConfirmDestroyDialog.vue` (new)**

Props:

- `title: string` — e.g. "Delete Project"
- `entityLabel: string` — e.g. project title
- `cascadeSummary: string[]` — bullet list (computed by caller) of what will be archived
- `confirmWord: string` — defaults to `"DESTROY"`
- `loading: boolean`

Emits: `confirm`, `cancel`.

Behavior: Renders a warning panel listing the cascade summary, a `q-input` where the user must type `confirmWord` exactly. The red confirm button is disabled until the typed value matches.

**Project store** (`frontend/src/stores/projects.ts`)

- New action `archiveProject(projectId)` → calls `POST /projects/:id/archive`.
- On success: refresh project list; navigate user back to the projects index.
- Project lists already filter on `status` — confirm archived projects are excluded from the active list (and only visible in an "Archived" view if/when one is added later).

---

## 2. Edit & delete milestone / contribution / sub-contribution

### Backend

**Schema change**

- Add `'archived'` to `MilestoneStatus` enum:
  - `frontend/src/types/projects.ts` — extend the union.
  - `backend/internal/contributions/models.go` — add `MilestoneArchived` constant.
  - Update any DB string-constraint or migration if one exists (verify during plan).

**New endpoints**

```
POST /api/v1/milestones/:id/archive
POST /api/v1/contributions/:id/archive
```

- RBAC:
  - `ActionArchiveMilestone` (admin, steward, lead)
  - `ActionArchiveContribution` (admin, steward, lead)
- Cascade rules:
  - Milestone archive → all contributions under that milestone → recursive sub-contributions
  - Contribution archive → recursive sub-contributions
- Sub-contribution archive uses the same `/contributions/:id/archive` endpoint (sub-contributions are contributions with a `parent_id`).
- All cascades transactional.

**Existing PUT endpoints**

- Verify `PUT /api/v1/milestones/:id` and `PUT /api/v1/contributions/:id` cover the editable fields. Augment if any field on the form isn't already accepted.

### Frontend

**Reused / renamed components**

- `ContributionForm.vue` — extend with edit mode:
  - Accept an optional `contribution: Contribution` prop. When set, prefill fields and call PUT instead of POST on save.
  - Used for both top-level contribution edit and sub-contribution edit (sub-contributions are passed in the same way).
- `AddMilestoneDialog.vue` → rename to `MilestoneFormDialog.vue` with a `mode: 'create' | 'edit'` prop and an optional `milestone` prop for prefill. Update existing call sites.

**Edit / delete entry points**

- Add a pencil icon and a trash icon next to each:
  - Milestone row (in the implementation plan view)
  - Contribution row (top-level)
  - Sub-contribution row (nested under its parent)
- Both icons gated by edit permission (admin/steward/lead).
- Pencil opens the appropriate form (or dialog) in edit mode.
- Trash opens `ConfirmArchiveDialog.vue` (basic confirm, see below).

**`ConfirmArchiveDialog.vue` (new)**

Props:

- `title: string`
- `message: string` — caller composes a per-entity warning, e.g. "Archiving this milestone will also archive its 4 contributions and 7 sub-contributions. This cannot be undone from the UI."
- `loading: boolean`

Basic confirm/cancel buttons (no typed-confirmation — that's reserved for project delete only).

**Stores**

- `contributions` store: add `updateContribution`, `archiveContribution`, `updateMilestone`, `archiveMilestone` actions matching the new endpoints. (`createChild` already exists for sub-contributions.)

---

## 3. Unassign contributor

### Backend

**New endpoint**

```
POST /api/v1/contributions/:id/unassign
```

- RBAC: `ActionUnassignContribution` (admin, steward, lead).
- Guard: returns HTTP 409 if `contribution.status` is not in `{assigned, in_progress}`.
- Effect:
  - `assigned_contributor_id = ""`
  - `status = 'confirmed'`
- Returns the updated contribution.

**New action constant**

- `ActionUnassignContribution` added to `roles.go`.

### Frontend

**Contribution edit screen** (`ContributionForm.vue`, edit mode only)

- Add a small "Unassign contributor" button under the assignment block, visible only when ALL of:
  - `assigned_contributor_id` is set
  - `status ∈ {assigned, in_progress}`
  - User has unassign permission (admin/steward/lead)
- Click opens a basic confirmation: "This will set the contribution back to 'confirmed' and clear the assigned contributor."
- On confirm, calls new endpoint via store action `unassignContribution(id)`. On success, refreshes the contribution and re-renders the form (button disappears).

---

## 4. Submit project complete (lead → steward signoff)

### Backend

**Schema change**

- Add `'pending_completion'` to `ProjectStatus` enum:
  - `frontend/src/types/projects.ts`
  - `backend/internal/contributions/models.go` (add `ProjectPendingCompletion` constant)
  - Update any DB constraint or migration.
- Add fields to `Project` model: `CompletedBy string`, `CompletedAt *time.Time`, `RejectionReason string` (nullable; cleared when a new submit is made).

**New endpoints**

```
POST /api/v1/projects/:id/submit-completion        (lead)
POST /api/v1/projects/:id/approve-completion       (steward, admin)
POST /api/v1/projects/:id/reject-completion        (steward, admin)
```

- `submit-completion`:
  - Guard: every contribution in the project must be `signed_off` (404/409 if not).
  - Guard: project status must be `active` (cannot submit from `created`, `pending_completion`, `completed`, `archived`).
  - Sets `project.status = 'pending_completion'`. Clears any prior `rejection_reason`.
- `approve-completion`:
  - Guard: project status must be `pending_completion`.
  - Sets `project.status = 'completed'`, `completed_by = caller`, `completed_at = now`.
- `reject-completion`:
  - Guard: project status must be `pending_completion`.
  - Optional `rejection_reason` in body.
  - Sets `project.status = 'active'`, stores `rejection_reason`.

**New action constants**

- `ActionSubmitProjectCompletion` (lead), `ActionApproveProjectCompletion` (steward, admin), `ActionRejectProjectCompletion` (steward, admin).

### Frontend

**Project detail page** — new "Project Completion" section.

State machine for the section:

| Project status | Viewer role | UI |
| --- | --- | --- |
| `active` + all contributions `signed_off` | Lead | Button: "Submit for Steward Review" |
| `active` + all contributions `signed_off` | Other | "All contributions signed off — awaiting lead to submit for steward review." |
| `active` (some contributions not yet signed off) | Anyone | Show progress: "X / Y contributions signed off" |
| `pending_completion` | Steward / admin | Buttons: "Approve Completion", "Send Back" (latter opens dialog with optional reason input) |
| `pending_completion` | Other | "Awaiting steward signoff." If `rejection_reason` exists from a prior cycle, do not display (it's been cleared on resubmit). |
| `completed` | Anyone | "Completed by {name} on {date}." |

**Status badge**

- Add `pending_completion` styling (amber/warning) to the existing project status pill component.
- After "Send Back", project returns to `active` with `rejection_reason` populated. The lead sees the reason on the project page (e.g., a banner: "Steward sent back: {reason}").

**Stores**

- `projects` store: add `submitCompletion(id)`, `approveCompletion(id)`, `rejectCompletion(id, reason?)`.
- A computed selector `allContributionsSignedOff(projectId)` (in the contributions store or the projects store, depending on existing patterns) drives the visibility of the submit button.

---

## 5. Equalize input heights

### Frontend only

- In `ContributionForm.vue`, the array fields (`objectives`, `deliverables`, `acceptance_criteria`) currently use `<q-input dense />` (single line).
- Update them to match the proposal pattern used in `CreateProposalDialog.vue`: `<q-input type="textarea" autogrow />`.
- Verify the proposal form's three fields are themselves identical and consistent.
- If markup duplication justifies it, lift into a small `ArrayItemInput.vue` component shared by both forms. **Skip this abstraction unless all three fields end up styled identically across both forms.**

No backend changes.

---

## Cross-Cutting

### Permissions summary

| Action | Admin | Steward | Lead |
| --- | --- | --- | --- |
| Archive project | ✓ | ✓ | ✓ |
| Archive milestone | ✓ | ✓ | ✓ |
| Archive contribution / sub-contribution | ✓ | ✓ | ✓ |
| Unassign contributor | ✓ | ✓ | ✓ |
| Submit project for completion | — | — | ✓ |
| Approve project completion | ✓ | ✓ | — |
| Reject project completion | ✓ | ✓ | — |

### Status transitions added/changed

- **ProjectStatus** gains: `pending_completion`. New transitions:
  - `active → pending_completion` (lead, via submit)
  - `pending_completion → completed` (steward/admin, via approve)
  - `pending_completion → active` (steward/admin, via reject)
  - `* → archived` (admin/steward/lead, via project archive)
- **MilestoneStatus** gains: `archived`. New transition: `* → archived`.
- **ContributionStatus**: no enum change; new transitions:
  - `* → archived` (via cascade or direct archive)
  - `{assigned, in_progress} → confirmed` (via unassign)

### Testing

- Backend: unit tests for each new handler covering happy path, RBAC denial, guard violations (e.g., submit when not all contributions signed off; unassign when status is not allowed). Cascade tests verify all child entities transition.
- Frontend: component tests for new dialogs (`ConfirmDestroyDialog`, `ConfirmArchiveDialog`) covering enable/disable on typed-confirmation, click behavior. E2E tests for end-to-end flows: delete project, edit milestone, unassign contributor, submit project for completion → approve, submit → reject.
- Verify existing E2E suites still pass after status enum additions.

### Risks / edge cases

- **Sub-contribution depth**: archive cascade is recursive on `parent_id`; verify no cycle protection is needed (parent_id should be a DAG by construction). Document the assumption in the handler.
- **Concurrent edits**: if a steward approves completion while a lead is editing a contribution, the contribution edit may fail (project is now `completed`). Acceptable; edit endpoints can return a clear error and the UI surfaces it.
- **Resubmission after rejection**: `submit-completion` clears `rejection_reason`. The lead can re-submit any number of times.
- **Sub-contribution edit sharing the form**: confirm during implementation that no top-level-only fields cause confusion when shown for sub-contributions; hide irrelevant fields with a `v-if` based on `parent_id`.
