# Contributions UX Flow: Project Creation to Contribution Completion

## Cross-Reference Table: Documentation vs. Vue Implementation

> Source UI: `frontend/src/` (Vue 3 / Quasar / TypeScript)
> Source Doc: `PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md`
> Updated: March 16, 2026

---

## Phase 1: Project Creation

| Step | Action | Actor | Vue Component | UI Element | Status | Notes |
|------|--------|-------|--------------|------------|--------|-------|
| 1.1 | Navigate to Projects screen | Any user | `pages/ProjectsPage.vue` | Project list with status filter pills (All/Active/Created/Completed/Archived) | MATCH | |
| 1.2 | Click "+ New Project" | Admin only | `pages/ProjectsPage.vue` | `q-btn` with Plus icon, rendered for admin role | MATCH | |
| 1.3 | Fill out project form | Admin | `components/projects/ProjectForm.vue` | Dialog with Title and Description fields | PARTIAL | Doc specifies Lead, Steward, Tags fields. These are assigned post-creation via AssignRoleDialog on the detail page. |
| 1.4 | Submit project | Admin | `components/projects/ProjectForm.vue` | "Create Project" button emits `submit` with `{ title, description }` | MATCH | |

### Phase 1 Notes

- **Lead/Steward fields**: Not in the create dialog by design. Assignment happens on the project detail page via `AssignRoleDialog.vue`, which provides a searchable member list. This matches the actual user workflow better than front-loading role selection at creation time.

---

## Phase 2: Assign Team & Structure Work

| Step | Action | Actor | Vue Component | UI Element | Status | Notes |
|------|--------|-------|--------------|------------|--------|-------|
| 2.1 | Open project detail | Any user | `pages/Projects/ProjectDetailPage.vue` | Click on ProjectCard navigates to `/dashboard/projects/:id` | MATCH | |
| 2.2 | Assign Project Lead | Admin | `components/projects/AssignRoleDialog.vue` | "Assign Lead" button in header opens dialog with search + member list | MATCH | |
| 2.3 | Assign Project Steward | Admin | `components/projects/AssignRoleDialog.vue` | "Assign Steward" button in header opens same dialog | MATCH | |
| 2.4 | Create first milestone | Project Lead | `components/projects/AddMilestoneDialog.vue` | "Create First Milestone" button (empty state) or "Add Milestone" button (header) | MATCH | |
| 2.5 | Fill milestone form | Project Lead | `components/projects/AddMilestoneDialog.vue` | Title*, Duration*, Description, Start/End dates, Success Criteria list | MATCH | |
| 2.6 | Create contribution in milestone | Project Lead | `components/projects/CreateContributionDialog.vue` | "Add Contribution" button on MilestoneCard opens dialog | MATCH | |
| 2.7 | Fill contribution form | Project Lead | `components/projects/CreateContributionDialog.vue` | Title*, Description*, Type* (2x2 grid), Priority* (2x2 grid), Estimated Hours, Deadline, Budget, Objectives*, Deliverables*, Acceptance Criteria, Skill Requirements | MATCH | Multi-value fields use add/remove + Enter key |

### Phase 2 Notes

- Implementation plan is auto-created when the first milestone is added. There is no separate "Create Plan" step — the plan is implicit.

---

## Phase 3: Confirm Contributions & Sign Off Plan

| Step | Action | Actor | Vue Component | UI Element | Status | Notes |
|------|--------|-------|--------------|------------|--------|-------|
| 3.1 | View confirmation progress | Admin | `pages/Projects/ProjectDetailPage.vue` | Progress bar "X / Y confirmed" in Implementation Plan section | MATCH | |
| 3.2 | Confirm individual contribution | Admin / Steward | `components/projects/ContributionCardCompact.vue` | "Confirm" q-btn (shown when `canConfirm && status=created`) | MATCH | Confirmation happens BEFORE plan sign-off |
| 3.3 | Sign off implementation plan | Steward / Admin | `pages/Projects/ProjectDetailPage.vue` | "Sign Off Plan" button (visible when all contributions confirmed) | MATCH | |
| 3.4 | View signed-off state | Any user | `pages/Projects/ProjectDetailPage.vue` | "Implementation Plan Signed Off" banner with signer name and date | MATCH | |
| 3.5 | Milestones lock visually | Any user | `components/projects/MilestoneCard.vue` | Header turns primary color, "Locked" badge appears, edit/add buttons hidden | MATCH | |
| 3.6 | View per-milestone progress | Any user | `components/projects/MilestoneCard.vue` | `q-linear-progress` bar with "X of Y confirmed" label and contribution count | MATCH | |

---

## Phase 4: Distribute Work (Share or Offer)

| Step | Action | Actor | Vue Component | UI Element | Status | Notes |
|------|--------|-------|--------------|------------|--------|-------|
| 4.1a | Share from compact card | Lead / Steward / Admin | `components/projects/ContributionCardCompact.vue` | "Share" q-btn (shown when `isPlanSignedOff && isLead && isConfirmed`) | MATCH | Emits `share` event to parent |
| 4.1b | Share from detail dialog | Lead / Steward / Admin | `components/projects/ContributionDetailDialog.vue` | "Share" button in sticky footer, opens Share Dialog | MATCH | |
| 4.2 | Select roles to share with | Lead / Steward / Admin | `components/projects/ContributionDetailDialog.vue` | Share Dialog with role checkboxes: Contributors, Members, Project Leads | MATCH | |
| 4.3 | Confirm share | Lead / Steward / Admin | `components/projects/ContributionDetailDialog.vue` | Calls `store.share(id, { shared_with_roles })`, status → `shared` | MATCH | |
| 4.4 | View shared status | Any user | `components/projects/ContributionDetailDialog.vue` | "Shared with community" panel showing role list | MATCH | |
| 4.5a | Offer from compact card | Lead / Steward / Admin | `components/projects/ContributionCardCompact.vue` | "Offer" q-btn next to Share button | MATCH | Emits `offer` event to parent |
| 4.5b | Offer from detail dialog | Lead / Steward / Admin | `components/projects/ContributionDetailDialog.vue` | "Offer" button in sticky footer, opens Offer Dialog | MATCH | |
| 4.6 | Select member to offer to | Lead / Steward / Admin | `components/projects/ContributionDetailDialog.vue` | Offer Dialog with User ID and User Name inputs | MATCH | |
| 4.7 | Confirm offer | Lead / Steward / Admin | `components/projects/ContributionDetailDialog.vue` | Calls `store.offer(id, { offered_to, offered_to_name })`, status → `offered` | MATCH | |
| 4.8 | View offered status | Any user | `components/projects/ContributionDetailDialog.vue` | "Offered to [name]" panel with date and Accept button (if offered to current user) | MATCH | |
| 4.9 | Offer from interest list | Lead / Steward / Admin | `components/projects/ContributionDetailDialog.vue` | Per-contributor "Offer" button in Interested Contributors section | MATCH | |

---

## Phase 5: Accept Work / Register Interest

| Step | Action | Actor | Vue Component | UI Element | Status | Notes |
|------|--------|-------|--------------|------------|--------|-------|
| 5.1 | View shared contributions | Member / Contributor | `pages/Contributions/ContributionsPage.vue` | Status filter "Open" shows shared/offered contributions | MATCH | |
| 5.2 | Register interest | Member / Contributor | `components/projects/ContributionDetailDialog.vue` | "Register Interest" button in footer (visible when `canRegister`) | MATCH | |
| 5.3 | Fill interest note | Member / Contributor | `components/projects/ContributionDetailDialog.vue` | Interest Dialog with textarea "Why are you interested?" | MATCH | |
| 5.4 | Submit interest | Member / Contributor | `components/projects/ContributionDetailDialog.vue` | Calls `store.registerInterest(id, { interest_note })` | MATCH | |
| 5.5 | View interested contributors | Lead / Steward / Admin | `components/projects/ContributionDetailDialog.vue` | List showing avatar, name, note, date, and "Offer" button per contributor | MATCH | |
| 5.6 | Accept offer | Offered Member | `components/projects/ContributionDetailDialog.vue` | "Accept Offer" button in footer/offered panel, calls `store.acceptOffer(id)` | MATCH | Status → `assigned` |
| 5.7 | Accept from detail page | Offered Member | `pages/Contributions/ContributionDetailPage.vue` | "Accept Offer" q-btn in `#actions` slot | MATCH | |

---

## Phase 6: Do the Work (Sub-Contributions)

| Step | Action | Actor | Vue Component | UI Element | Status | Notes |
|------|--------|-------|--------------|------------|--------|-------|
| 6.1 | View assigned contribution | Assigned Contributor | `pages/Contributions/ContributionDetailPage.vue` | Full contribution detail with evidence/review slots | MATCH | |
| 6.2 | Add sub-contribution | Lead or Assigned Contributor | `components/projects/ContributionDetailDialog.vue` | "+ Add Sub-Contribution" button in Sub-Contributions section | MATCH | Opens CreateContributionDialog with parentContributionId |
| 6.3 | Sub-contribution created | System | `components/projects/CreateContributionDialog.vue` | Status set to `created` (lead/steward) or `pending_approval` (member/contributor) | MATCH | Role-based initial status |
| 6.4 | Approve sub-contribution | Lead / Admin | `components/projects/ContributionDetailDialog.vue` | "Approve" button on pending sub-items, calls `store.approveSub(id)` | MATCH | Auto-assigns to parent's contributor |
| 6.5 | View sub-contributions on card | Any user | `components/projects/ContributionCardCompact.vue` | Sub-contribution preview: count badge, first 3 items with title + status badge, "+ N more" | MATCH | |
| 6.6 | Click sub-contribution to manage | Any user | `components/projects/ContributionDetailDialog.vue` | Clickable sub-item rows open recursive `ContributionDetailDialog` | MATCH | Full workflow actions available in nested dialog |
| 6.7 | View blocking children warning | Assigned Contributor | `components/projects/ContributionDetailDialog.vue` | Warning panel listing each unsigned child by name with status badge | MATCH | Blocks evidence submission |
| 6.8 | Flat hierarchy enforced | System | `composables/useContributionWorkflow.ts` | `canAddSubContribution()` returns `false` if `contribution.parent_contribution` is set | MATCH | Sub-contributions cannot have children |

---

## Phase 7: Submit Evidence

| Step | Action | Actor | Vue Component | UI Element | Status | Notes |
|------|--------|-------|--------------|------------|--------|-------|
| 7.1 | Check blocking children | System | `components/projects/ContributionDetailDialog.vue` | Warning with individual child names + status badges; Submit button disabled if blocked | MATCH | |
| 7.2 | Fill completion notes | Assigned Contributor | `components/projects/ContributionDetailDialog.vue` | Textarea in evidence form section | MATCH | |
| 7.3 | Fill acceptance criteria responses | Assigned Contributor | `components/projects/ContributionDetailDialog.vue` | Per-criterion textarea showing criterion text with response field | MATCH | |
| 7.4 | Add evidence URLs | Assigned Contributor | `components/projects/ContributionDetailDialog.vue` | Input + "Add" button, list with remove buttons | MATCH | |
| 7.5 | Upload time report | Assigned Contributor | `components/projects/ContributionDetailDialog.vue` | Dashed drop zone for .pdf/.csv/.xlsx, shows file name when uploaded, remove button | MATCH | |
| 7.6 | Upload attachments | Assigned Contributor | `components/projects/ContributionDetailDialog.vue` | Multi-file dashed drop zone, shows file list with remove buttons | MATCH | |
| 7.7 | Enter actual hours | Assigned Contributor | `components/projects/ContributionDetailDialog.vue` | Number input for actual duration | MATCH | |
| 7.8 | Submit for review | Assigned Contributor | `components/projects/ContributionDetailDialog.vue` | "Submit for Review" button calls `store.submitEvidence()` with all fields | MATCH | Status → `needs_review` |
| 7.9 | Evidence on detail page | Assigned Contributor | `pages/Contributions/ContributionDetailPage.vue` | Evidence dialog with completion notes, evidence URLs (add/remove), actual hours | MATCH | |

---

## Phase 8: Review

| Step | Action | Actor | Vue Component | UI Element | Status | Notes |
|------|--------|-------|--------------|------------|--------|-------|
| 8.1 | View review controls | Lead / Admin | `components/projects/ContributionDetailDialog.vue` | Review form section (visible when `canReviewNow`, status=`needs_review`) | MATCH | |
| 8.2 | View submitted evidence | Lead / Admin | `components/projects/ContributionDetailDialog.vue` | Read-only evidence display: completion notes, evidence URLs | MATCH | |
| 8.3 | Select outcome | Lead / Admin | `components/projects/ContributionDetailDialog.vue` | Three buttons: Approve / Send Back / Decline | MATCH | |
| 8.4 | Rate quality (dialog) | Lead / Admin | `components/projects/ContributionDetailDialog.vue` | 10-star click interface (clickable star/star_border icons) | MATCH | |
| 8.5 | Rate quality (page) | Lead / Admin | `pages/Contributions/ContributionDetailPage.vue` | 10-star click interface matching dialog pattern | MATCH | |
| 8.6 | Write feedback | Lead / Admin | `components/projects/ContributionDetailDialog.vue` | Textarea for review feedback | MATCH | |
| 8.7 | Submit review | Lead / Admin | `components/projects/ContributionDetailDialog.vue` | Calls `store.review(id, { outcome, feedback, quality_rating })` | MATCH | |
| 8.8a | Outcome: Approved | System | | Status → `approved` | MATCH | |
| 8.8b | Outcome: Incomplete | System | | Status → `assigned` (contributor reworks, loops to Phase 7) | MATCH | |
| 8.8c | Outcome: Declined | System | | Status → `archived` | MATCH | |
| 8.9 | View review feedback | Any user | `pages/Contributions/ContributionDetailPage.vue` | Read-only: outcome badge (Approved/Sent Back/Declined), star rating, feedback text | MATCH | |

---

## Phase 9: Sign-Off & Reward

| Step | Action | Actor | Vue Component | UI Element | Status | Notes |
|------|--------|-------|--------------|------------|--------|-------|
| 9.1 | See sign-off section | Steward / Admin | `components/projects/ContributionDetailDialog.vue` | Sign-off panel (visible when `canSignOffNow`, status=`approved`) | MATCH | |
| 9.2 | Click "Sign Off" | Steward / Admin | `components/projects/ContributionDetailDialog.vue` | Sign Off button calls `store.signOff(id)` | MATCH | |
| 9.3 | Sign-off on detail page | Steward / Admin | `pages/Contributions/ContributionDetailPage.vue` | "Sign Off" q-btn in `#actions` slot | MATCH | |
| 9.4 | View signed-off state | Any user | `components/projects/ContributionDetailDialog.vue` | "Signed Off" confirmation panel with signer info | MATCH | |
| 9.5 | Transition to Rewarded | System | N/A | **NOT IMPLEMENTED** | DEFERRED | Treasury integration is a future enhancement. The `rewarded` status exists in types and badge styling but no UI triggers it. |

---

## Phase 10: Contribution Change

| Step | Action | Actor | Vue Component | UI Element | Status | Notes |
|------|--------|-------|--------------|------------|--------|-------|
| 10.1 | View "Change Contribution" button | Assigned Contributor or Lead | `components/projects/ContributionDetailDialog.vue` | "Change Contribution" q-btn with `edit_note` icon in footer (visible when `canChangeNow`, status=`assigned`) | MATCH | |
| 10.2 | Open change dialog | Contributor / Lead | `components/projects/CreateContributionDialog.vue` | Reuses CreateContributionDialog with `editing=true` and `contribution` props | MATCH | Title shows "Change Contribution" |
| 10.3 | See re-confirmation warning | Contributor / Lead | `components/projects/CreateContributionDialog.vue` | Warning `q-banner`: "This change requires re-confirmation" | MATCH | |
| 10.4 | Edit fields | Contributor / Lead | `components/projects/CreateContributionDialog.vue` | Pre-populated form fields (type is read-only badge, all other fields editable) | MATCH | |
| 10.5 | Provide reason for change | Contributor / Lead | `components/projects/CreateContributionDialog.vue` | Required "Reason for Change" textarea | MATCH | Validated before submit |
| 10.6 | Submit change | Contributor / Lead | `components/projects/ContributionDetailDialog.vue` | `handleChange()` calls `store.update()` then `store.transition(id, 'changed')` | MATCH | Status → `changed` |
| 10.7 | Re-confirm contribution | Steward / Admin | `components/projects/ContributionCardCompact.vue` | "Confirm" button (visible when `canConfirm` — now accepts `changed` status) | MATCH | `canConfirm` updated to allow `created` OR `changed` |
| 10.8 | Continue workflow | Assigned Contributor | `components/projects/ContributionDetailDialog.vue` | `canSubmitEvidence()` allows submission from `assigned` or `changed` status | MATCH | Contributor can re-submit evidence |

### Phase 10 Notes

- The `changed` status exists in the type system and has badge styling ("Changes Requested" in teal).
- Evidence submission is allowed for both `assigned` and `changed` statuses.
- The change dialog reuses `CreateContributionDialog.vue` with `editing` and `contribution` props, adding a re-confirmation warning banner and a required "Reason for Change" textarea.
- `canConfirm()` in the workflow composable accepts both `created` and `changed` statuses, enabling re-confirmation after a change.

---

## Component Reference Map

| Component | Path | Purpose |
|-----------|------|---------|
| ProjectsPage | `pages/ProjectsPage.vue` | Project list with filtering |
| ProjectDetailPage | `pages/Projects/ProjectDetailPage.vue` | Project detail, plan, milestones |
| ContributionsPage | `pages/Contributions/ContributionsPage.vue` | Contribution list with filtering |
| ContributionDetailPage | `pages/Contributions/ContributionDetailPage.vue` | Contribution detail with all actions |
| ProposalsPage | `pages/ProposalsPage.vue` | Proposal list with filtering |
| ProposalDetailPage | `pages/ProposalDetailPage.vue` | Proposal lifecycle management |
| ProjectForm | `components/projects/ProjectForm.vue` | Create/edit project dialog |
| ProjectCard | `components/projects/ProjectCard.vue` | Project list card |
| ProjectDetail | `components/projects/ProjectDetail.vue` | Project detail display |
| AssignRoleDialog | `components/projects/AssignRoleDialog.vue` | Lead/steward assignment |
| AddMilestoneDialog | `components/projects/AddMilestoneDialog.vue` | Milestone creation |
| MilestoneCard | `components/projects/MilestoneCard.vue` | Milestone with progress + contributions |
| ContributionCardCompact | `components/projects/ContributionCardCompact.vue` | Compact card in milestone context |
| ContributionDetailDialog | `components/projects/ContributionDetailDialog.vue` | Full detail dialog with all workflows |
| CreateContributionDialog | `components/projects/CreateContributionDialog.vue` | Contribution creation form |
| ContributionCard | `components/contributions/ContributionCard.vue` | Card for contributions list page |
| ContributionForm | `components/contributions/ContributionForm.vue` | Create/edit contribution form |
| ContributionDetail | `components/contributions/ContributionDetail.vue` | Contribution display with slots |
| ContributionStatusBadge | `components/contributions/ContributionStatusBadge.vue` | Status badge rendering |
| CreateProposalDialog | `components/proposals/CreateProposalDialog.vue` | Proposal creation form |
| EndorseProposalModal | `components/proposals/EndorseProposalModal.vue` | Endorsement dialog |
| CreateDecisionPlanDialog | `components/proposals/CreateDecisionPlanDialog.vue` | Decision plan creation |
| DecisionPlanView | `components/proposals/DecisionPlanView.vue` | Decision plan display |
| useContributionWorkflow | `composables/useContributionWorkflow.ts` | Permission matrix for all actions |

---

## Outstanding Items

| # | Severity | Item | Notes |
|---|----------|------|-------|
| 1 | LOW | `rewarded` status transition | Treasury integration is deferred. Status exists in types but no UI triggers it |
| 2 | LOW | Share dialog role names | Design has Community Representatives, Technical Team, Cultural Committee; Vue has Contributors, Members, Project Leads. This is data-driven. |

### Resolved Items (this session)

| # | Item | Resolution |
|---|------|-----------|
| ~~1~~ | ChangeContributionDialog | Implemented via `CreateContributionDialog.vue` with `editing` + `contribution` props, re-confirmation warning, reason-for-change field |
| ~~2~~ | Re-confirmation workflow | `canConfirm()` updated to accept `changed` status; `canChange()` guard added; `handleChange()` wired in ContributionDetailDialog |
