# Contributions UX Flow: Project Creation to Contribution Completion

## Cross-Reference Table: Documentation vs. UI Implementation

> Source UI: `../Mātou Wallet Design(6)/src/components/`
> Source Doc: `PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md`

---

## Phase 1: Project Creation

| Step | Action | Actor | UI Component | UI Element | Match? | Notes |
|------|--------|-------|-------------|------------|--------|-------|
| 1.1 | Navigate to Projects screen | Any user | `screens/ProjectsScreen.tsx` | Project list view with search bar and status filters (All/Created/Active/Completed/Archived) | MATCH | |
| 1.2 | Click "New Project" | Admin only | `screens/ProjectsScreen.tsx:648` | `<Button>` with Plus icon, conditionally rendered via `isAdmin` check | PARTIAL | Doc says "Community Admin" role; UI uses simplified `admin` vs `member` role model |
| 1.3 | Fill out project form | Admin | `projects/CreateProjectDialog.tsx` | Dialog with Title* and Description* fields | MISMATCH | Doc specifies additional fields: Project Lead, Project Steward, Tags, Initial Implementation Plan, Initial Milestones. **UI only has Title and Description.** |
| 1.4 | Submit project | Admin | `projects/CreateProjectDialog.tsx:117` | "Create Project" button | MATCH | Project created with status `created` |

### Phase 1 Discrepancies

- **Missing fields in CreateProjectDialog**: The doc specifies Project Lead (auto-filled), Project Steward (select), Tags (multi-select), Initial Implementation Plan, and Initial Milestones. The actual UI only has Title and Description. Lead/Steward are assigned later via `AssignRoleDialog` from within `ProjectDetail`.
- **Role model simplification**: The UI uses a 2-tier role model (`admin`/`member`) rather than the 5-role RBAC described in the doc (`community_admin`/`project_lead`/`project_steward`/`contributor`/`member`).

---

## Phase 2: Assign Team & Structure Work

| Step | Action | Actor | UI Component | UI Element | Match? | Notes |
|------|--------|-------|-------------|------------|--------|-------|
| 2.1 | Open project detail | Any user | `screens/ProjectsScreen.tsx:702` | Click on project card in list | MATCH | |
| 2.2 | Assign Project Lead | Admin | `projects/ProjectDetail.tsx:1063` | "Assign Lead" ghost button in header, opens `AssignRoleDialog` | MATCH | Searchable user list with role display |
| 2.3 | Assign Project Steward | Admin | `projects/ProjectDetail.tsx:1083` | "Assign Steward" ghost button in header, opens `AssignRoleDialog` | MATCH | Same dialog, different role context |
| 2.4 | Create first milestone | Project Lead (Admin) | `projects/ProjectDetail.tsx:1289` | "Create First Milestone" button (empty state) or "Add Milestone" button (header) | MATCH | Opens `AddMilestoneDialog` |
| 2.5 | Fill milestone form | Project Lead | `projects/AddMilestoneDialog.tsx` | Dialog with Title*, Duration*, and optional inline contribution creation | MATCH | Can pre-add contributions within the milestone dialog |
| 2.6 | Create contribution within milestone | Project Lead | `projects/MilestoneCard.tsx:198` | "Add Contribution" button below existing contributions, or "Add First Contribution" button (empty state) | MATCH | Opens `CreateContributionDialog` |
| 2.7 | Fill contribution form | Project Lead | `projects/CreateContributionDialog.tsx` | Dialog with: Title*, Description*, Type* (4 options), Priority* (4 options), Estimated Hours, Deadline, Objectives*, Deliverables*, Acceptance Criteria, Skill Requirements | MATCH | Multi-value fields use add/remove pattern with Enter key support |

### Phase 2 Discrepancies

- **No explicit Implementation Plan creation**: The doc describes creating an implementation plan as a discrete step. In the UI, the plan is implicitly created when the first milestone is added (`ProjectDetail.tsx:953-965`).
- **Plan does not have its own "create" dialog**: It auto-creates with a default budget of "TBD".

---

## Phase 3: Confirm Contributions & Sign Off Plan

| Step | Action | Actor | UI Component | UI Element | Match? | Notes |
|------|--------|-------|-------------|------------|--------|-------|
| 3.1 | View confirmation progress | Admin | `projects/ProjectDetail.tsx:1213-1229` | Progress bar showing "X / Y confirmed" with percentage | MATCH | Only visible when plan is not signed off and progress < 100% |
| 3.2 | Confirm individual contribution | Project Steward / Admin | `projects/ContributionCard.tsx:281-294` | "Confirm" button with CheckCircle2 icon on each contribution card | MISMATCH | **Doc workflow (Section 5.1) says confirmation happens "after plan sign-off", but UI requires confirmation BEFORE plan sign-off.** The sign-off logic requires all contributions to be confirmed first. |
| 3.3 | Sign off implementation plan | Project Steward / Admin | `projects/ProjectDetail.tsx:1192-1210` | Green banner: "Ready for Sign Off" with "Sign Off Plan" button | MATCH | Only appears when: plan exists, not already signed off, milestones exist, ALL contributions confirmed |
| 3.4 | View signed-off confirmation | Any user | `projects/ProjectDetail.tsx:1232-1245` | Green "Implementation Plan Signed Off" badge with signer and date | MATCH | |
| 3.5 | Milestones lock visually | Any user | `projects/MilestoneCard.tsx:101-102,122-126` | Milestones turn primary color background with "Locked" badge | MATCH | Edit/Add buttons hidden when plan is signed off |

### Phase 3 Discrepancies

- **CRITICAL: Contradictory workflow in documentation**: Section 5.1 workflow diagram says `CREATED -> (Plan signed off) -> CONFIRMED`. But Section 5.3 sign-off logic says "All contributions must be confirmed before sign-off". **The UI follows the Section 5.3 logic** (confirm first, then sign off). The workflow diagram in Section 5.1 is wrong.
- **ContributionStatus type missing statuses**: The TypeScript type (`ProjectsScreen.tsx:10`) defines: `'created' | 'confirmed' | 'assigned' | 'changed' | 'needs_review' | 'approved' | 'incomplete' | 'declined' | 'signed_off' | 'rewarded' | 'archived'`. **Missing `'shared'` and `'offered'`** from the type, but both are used throughout the codebase via `as const` casts and string comparisons. Also **missing `'pending_approval'`** which is used for sub-contributions.

---

## Phase 4: Distribute Work (Share or Offer)

| Step | Action | Actor | UI Component | UI Element | Match? | Notes |
|------|--------|-------|-------------|------------|--------|-------|
| 4.1a | Click "Share" on contribution card | Project Lead | `projects/ContributionCard.tsx:297-310` | "Share" button with Share2 icon (only visible after plan signed off, status is confirmed/shared/offered) | MISMATCH | **Only `project_lead` can see Share button on card.** Doc RBAC says Project Steward can also share. |
| 4.1b | Open Share dialog | Project Lead | `projects/ContributionDetailDialog.tsx:984-986` | "Share Contribution" button in dialog footer | MISMATCH | **Same issue**: only `isProjectLead` check, not Steward. Doc says Steward can share too. |
| 4.2 | Select roles to share with | Project Lead | `projects/ContributionDetailDialog.tsx:1019-1039` | Overlay dialog with checkbox list: Contributors, Community Representatives, Technical Team, Cultural Committee | MATCH | Optional share link generation |
| 4.3 | Confirm share | Project Lead | `projects/ContributionDetailDialog.tsx:157-169` | Handler sets `status: 'shared'`, `is_shared: true`, `shared_with_roles` | MATCH | Toast: "Contribution shared successfully!" |
| 4.4 | View shared status | Any user | `projects/ContributionCard.tsx:245-260` | Green "Available to: [roles]" banner with Share2 icon, interest count | MATCH | |
| 4.5a | Click "Offer" on contribution card | Project Lead | `projects/ContributionCard.tsx:311-323` | "Offer" button with UserCheck icon | MISMATCH | Same role restriction as Share |
| 4.5b | Open Offer dialog | Project Lead | `projects/ContributionDetailDialog.tsx:988-991` | "Offer to Member" button in dialog footer | MATCH | |
| 4.6 | Select member to offer to | Project Lead | `projects/ContributionDetailDialog.tsx` | Search field + selectable member list (mock users) | MATCH | |
| 4.7 | Confirm offer | Project Lead | `projects/ContributionDetailDialog.tsx:171-188` | Handler sets `status: 'offered'`, `offered_to`, `offered_to_name`, `offered_at` | MATCH | |
| 4.8 | View offered status | Any user | `projects/ContributionCard.tsx:231-242` | Blue "Offered to [name]" banner with date | MATCH | |

### Phase 4 Discrepancies

- **Share/Offer restricted to Project Lead only**: Both `ContributionCard.tsx:297` and `ContributionDetailDialog.tsx:982` check `isProjectLead` or `userRole === 'project_lead'`. The doc RBAC (Section 6.2) says Project Steward and Community Admin can also share/offer. **UI does not grant these actions to Stewards.**
- **Offer from interest list works correctly**: `ContributionDetailDialog.tsx:499-510` shows an "Offer" button next to each interested contributor, visible to Project Lead.

---

## Phase 5: Accept Work / Register Interest

| Step | Action | Actor | UI Component | UI Element | Match? | Notes |
|------|--------|-------|-------------|------------|--------|-------|
| 5.1 | View shared contribution | Member / Contributor | `projects/ContributionCard.tsx:327-348` | "View Details" button with Eye icon + optional "Registered" badge | MATCH | |
| 5.2 | Register interest | Member / Contributor | `projects/ContributionDetailDialog.tsx:996-1001` | "Register Interest" button in dialog footer (visible when `!isProjectLead && !isProjectSteward && contribution.is_shared`) | MATCH | |
| 5.3 | Fill interest note | Member / Contributor | `projects/ContributionDetailDialog.tsx` | Interest dialog with text area for note | MATCH | |
| 5.4 | Submit interest | Member / Contributor | `projects/ContributionDetailDialog.tsx:190-208` | Adds to `interested_contributors` array | MATCH | Toast: "Interest registered successfully!" |
| 5.5 | View interested contributors | Project Lead | `projects/ContributionDetailDialog.tsx:479-515` | List of interested contributors with name, note, date, and "Offer" button next to each | MATCH | |
| 5.6 | View offered contribution | Offered Member | `projects/ContributionCard.tsx:351-364` | "View Details" button (visible when `offered_to === currentUserId`) | MATCH | |
| 5.7 | Accept offer | Offered Member | `projects/ContributionDetailDialog.tsx:1004-1009` | "Accept" button in dialog footer | MATCH | Sets status to `assigned`, clears offer fields |
| 5.8 | Decline offer | Offered Member | `projects/ContributionDetailDialog.tsx:1010-1015` | "Decline" button (outline variant) in dialog footer | MATCH | Returns status to `confirmed` |

### Phase 5 Discrepancies

- None significant. This phase matches well between doc and UI.

---

## Phase 6: Do the Work (Sub-Contributions)

| Step | Action | Actor | UI Component | UI Element | Match? | Notes |
|------|--------|-------|-------------|------------|--------|-------|
| 6.1 | View assigned contribution | Assigned Contributor | `projects/ContributionCard.tsx:367-380` | "View Details" button (visible when `assigned_contributor === currentUserId`) | MATCH | |
| 6.2 | Add sub-contribution | Project Lead or Assigned Contributor | `projects/ContributionDetailDialog.tsx:587-597` | "Add Sub-Contribution" button in "Sub-Contributions" section | MATCH | Opens `CreateContributionDialog` with `parentContributionId` |
| 6.3 | Sub-contribution initial status | System | `projects/CreateContributionDialog.tsx:117-122` | Status set to `'created'` (if lead/steward) or `'pending_approval'` (if member/contributor) | MISMATCH | **Doc says all sub-contributions start as `'created'`. UI differentiates: members get `'pending_approval'`, leads get `'created'`.** |
| 6.4 | Approve sub-contribution | Project Lead | `projects/ContributionDetailDialog.tsx:290-303` | "Approve" / "Decline" / "Archive" buttons in yellow "Pending Your Approval" banner | MISMATCH | **Doc workflow (Section 5.2) does not mention `'pending_approval'` status at all.** The doc says subs go `created -> assigned` after lead approves. UI adds an intermediate `pending_approval` state. |
| 6.5 | Sub-contribution auto-assignment | System | `projects/ContributionDetailDialog.tsx:296-298` | Auto-assigns to parent's `assigned_contributor` on approval | MATCH | |
| 6.6 | View sub-contributions on parent card | Any user | `projects/ContributionCard.tsx:494-552` | Nested list below parent card showing title, type badge, status badge, assignee, hours, ID | MATCH | |
| 6.7 | Click sub-contribution to view | Any user | `projects/ContributionCard.tsx:513-518` | Click opens `ContributionDetailDialog` for the child contribution | MATCH | Recursive dialog pattern |
| 6.8 | Atomic child creation | System | `projects/MilestoneCard.tsx:69-94` | `handleCreateChildContribution` updates parent's `child_contributions` array AND adds child to milestone in single operation | MATCH | Prevents race conditions |

### Phase 6 Discrepancies

- **`pending_approval` status undocumented**: The `CreateContributionDialog.tsx:120-122` introduces a `pending_approval` status for member-created sub-contributions. This status is not in the doc, not in the `ContributionStatus` type, but has UI rendering support in both `ContributionCard.tsx:156` and `ContributionDetailDialog.tsx:141`.
- **Sub-contribution hierarchy**: Doc says "Cannot have their own children (flat hierarchy)". UI enforces this via `{!isSubContribution && (...)}` guard on the sub-contributions section (`ContributionDetailDialog.tsx:583`). **MATCH**.

---

## Phase 7: Submit Evidence

| Step | Action | Actor | UI Component | UI Element | Match? | Notes |
|------|--------|-------|-------------|------------|--------|-------|
| 7.1 | Check sub-contribution blocking | System | `projects/ContributionDetailDialog.tsx:643-663` | Yellow "Sub-Contributions Not Complete" warning with AlertTriangle icon, lists pending subs | MATCH | |
| 7.2 | Click "Submit Evidence & Complete" | Assigned Contributor | `projects/ContributionDetailDialog.tsx:664-672` | Full-width button with Upload icon, **disabled** when `!allChildrenSignedOff` | MATCH | |
| 7.3 | Fill completion notes | Assigned Contributor | `projects/ContributionDetailDialog.tsx:680-686` | Textarea: "Describe how you completed this contribution..." | MATCH | |
| 7.4 | Fill acceptance criteria responses | Assigned Contributor | `projects/ContributionDetailDialog.tsx:690-705` | One Textarea per acceptance criterion, showing the criterion text above | MATCH | |
| 7.5 | Add evidence URLs | Assigned Contributor | `projects/ContributionDetailDialog.tsx:708-741` | Input + "Add" button with LinkIcon, list of added URLs with remove buttons | MATCH | |
| 7.6 | Upload time report | Assigned Contributor | `projects/ContributionDetailDialog.tsx:744-778` | File input accepting `.pdf,.csv,.xlsx,.xls,.doc,.docx`, shows uploaded file with FileText icon | MATCH | Mock upload (URL generated client-side) |
| 7.7 | Upload attachments | Assigned Contributor | `projects/ContributionDetailDialog.tsx:781-823` | Multi-file input accepting `*/*`, shows list of uploaded files | MATCH | |
| 7.8 | Enter actual hours | Assigned Contributor | `projects/ContributionDetailDialog.tsx:825-833` | Number input | MATCH | |
| 7.9 | Submit for review | Assigned Contributor | `projects/ContributionDetailDialog.tsx:836-838` | "Submit for Review" button with Send icon | MATCH | Sets status to `needs_review` |

### Phase 7 Discrepancies

- None. This phase is fully implemented and matches the documentation.

---

## Phase 8: Review

| Step | Action | Actor | UI Component | UI Element | Match? | Notes |
|------|--------|-------|-------------|------------|--------|-------|
| 8.1 | See "Review Submission" button | Project Lead | `projects/ContributionDetailDialog.tsx:848-852` | Full-width "Review Submission" button with FileText icon (visible when `isProjectLead && status === 'needs_review'`) | MATCH | |
| 8.2 | View submitted evidence | Project Lead | `projects/ContributionDetailDialog.tsx:860-884` | Read-only display of completion notes and evidence URLs | MATCH | |
| 8.3 | Select outcome | Project Lead | `projects/ContributionDetailDialog.tsx:888-912` | Three toggle buttons: "Approve" / "Incomplete" / "Decline" | MATCH | |
| 8.4 | Rate quality | Project Lead | `projects/ContributionDetailDialog.tsx:914-933` | Number input (1-10) + clickable star rating (10 stars) | MATCH | Doc describes "star interface" |
| 8.5 | Write feedback | Project Lead | `projects/ContributionDetailDialog.tsx:936-944` | Textarea: "Provide feedback..." | MATCH | |
| 8.6 | Submit review | Project Lead | `projects/ContributionDetailDialog.tsx:947-948` | "Submit Review" button with Send icon | MATCH | |
| 8.7a | Outcome: Approved | System | `projects/ContributionDetailDialog.tsx:256` | Status -> `approved` | MATCH | |
| 8.7b | Outcome: Incomplete | System | `projects/ContributionDetailDialog.tsx:257` | Status -> `assigned` (loops back to Phase 7) | MATCH | |
| 8.7c | Outcome: Declined | System | `projects/ContributionDetailDialog.tsx:258` | Status -> `archived` | MATCH | |

### Phase 8 Discrepancies

- **Review visible evidence incomplete**: The review section (`ContributionDetailDialog.tsx:860-884`) only displays `completion_notes` and `evidence_urls`. It does **not** display: acceptance criteria responses, time report file, attachment files, or actual hours. The reviewer cannot see all submitted evidence.

---

## Phase 9: Sign-Off & Reward

| Step | Action | Actor | UI Component | UI Element | Match? | Notes |
|------|--------|-------|-------------|------------|--------|-------|
| 9.1 | See sign-off section | Project Steward / Admin | `projects/ContributionDetailDialog.tsx:958-976` | Green "Ready for Sign Off" section with CheckCircle2 icon (visible when `isProjectSteward && status === 'approved'`) | MATCH | Note: `isProjectSteward` includes `project_lead` (line 72) |
| 9.2 | Click "Sign Off Contribution" | Project Steward / Admin | `projects/ContributionDetailDialog.tsx:971-974` | Full-width button with CheckCircle2 icon | MATCH | |
| 9.3 | Sign-off recorded | System | `projects/ContributionDetailDialog.tsx:276-287` | Sets `status: 'signed_off'`, `signed_off_by`, `signed_off_at` | MATCH | Toast: "Contribution signed off! Treasury action will be generated." |
| 9.4 | Transition to Rewarded | System | N/A | **NO UI EXISTS** | MISMATCH | **Doc describes `signed_off -> rewarded` transition triggered by treasury action. No UI or handler exists for this.** The `rewarded` status is defined in the type and has rendering support in status configs, but no mechanism triggers it. |

### Phase 9 Discrepancies

- **No `rewarded` transition**: The lifecycle ends at `signed_off` in the UI. The `rewarded` status exists in the type definition and has badge styling, but no button, handler, or automated mechanism transitions a contribution to `rewarded`.
- **Sign-off role blurring**: `isProjectSteward` is defined as `userRole === 'project_steward' || userRole === 'project_lead'` (`ContributionDetailDialog.tsx:72`), meaning Project Lead can also sign off. The doc says only Steward/Admin can sign off (Lead explicitly excluded in RBAC table). This was done intentionally "for testing" per the code comment.

---

## Summary of All Discrepancies

| # | Severity | Location | Issue |
|---|----------|----------|-------|
| 1 | HIGH | `CreateProjectDialog.tsx` | Missing fields: Project Lead, Project Steward, Tags, Initial Plan, Initial Milestones. Only Title and Description exist. |
| 2 | HIGH | `ProjectsScreen.tsx:10` | `ContributionStatus` type is missing `'shared'`, `'offered'`, and `'pending_approval'` statuses that are used throughout the UI. |
| 3 | HIGH | Doc Section 5.1 | **Internal doc contradiction**: Workflow diagram says confirmation happens AFTER plan sign-off, but Section 5.3 sign-off logic requires confirmation BEFORE sign-off. UI follows Section 5.3 (correct). |
| 4 | MEDIUM | `ContributionCard.tsx:297`, `ContributionDetailDialog.tsx:982` | Share/Offer actions restricted to `project_lead` only. Doc RBAC says Project Steward and Community Admin should also have access. |
| 5 | MEDIUM | `CreateContributionDialog.tsx:120` | Sub-contributions created by members start as `'pending_approval'`, not `'created'` as documented. The `pending_approval` status is undocumented. |
| 6 | MEDIUM | `ContributionDetailDialog.tsx:860-884` | Review section doesn't display all submitted evidence (missing: acceptance notes, time report, attachments, actual hours). |
| 7 | MEDIUM | No UI | No mechanism to transition contributions from `signed_off` to `rewarded`. Treasury integration is referenced but not implemented. |
| 8 | LOW | `ContributionDetailDialog.tsx:72` | Project Lead given Steward sign-off powers (`isProjectSteward = userRole === 'project_steward' || userRole === 'project_lead'`). Intentional for testing, but violates RBAC doc. |
| 9 | LOW | Role system | UI uses simplified 2-tier roles (`admin`/`member`) instead of the 5-role system described in docs. Role mapping happens at component level. |
| 10 | LOW | `ProjectDetail.tsx` | No explicit "Create Implementation Plan" step. Plan auto-creates when first milestone is added. |
