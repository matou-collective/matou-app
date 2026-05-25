# Projects & Contributions — Implementation Plan

**Version:** 1.0
**Date:** 2026-03-15
**Status:** Ready for Review
**Based on:** `PROJECTS_CONTRIBUTIONS_DOCUMENTATION.md` v1.0 + full codebase analysis

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Assessment](#2-current-state-assessment)
3. [Data Models (Go Backend)](#3-data-models-go-backend)
4. [API Endpoints](#4-api-endpoints)
5. [RBAC & Permission Logic](#5-rbac--permission-logic)
6. [Status Transition Machine](#6-status-transition-machine)
7. [Business Logic](#7-business-logic)
8. [Any-Sync Data Layer](#8-any-sync-data-layer)
9. [File Storage](#9-file-storage)
10. [SSE & Real-Time Events](#10-sse--real-time-events)
11. [Frontend TypeScript Types](#11-frontend-typescript-types)
12. [Pinia Store Design](#12-pinia-store-design)
13. [Vue Component Inventory](#13-vue-component-inventory)
14. [Frontend Pages & Routes](#14-frontend-pages--routes)
15. [API Client Functions](#15-api-client-functions)
16. [Composables](#16-composables)
17. [UI/UX Specification](#17-uiux-specification)
18. [E2E Test Plan](#18-e2e-test-plan)
19. [Backend Test Plan](#19-backend-test-plan)
20. [Implementation Stages](#20-implementation-stages)
21. [Risk Register](#21-risk-register)
22. [Review Checklist](#22-review-checklist)

---

## 1. Executive Summary

The codebase has a strong foundation — approximately 40% of the feature is implemented. The `contributions` package has models, a service layer, and validation. The `api` package has handlers for projects, contributions, implementation plans, and proposals. The frontend has stub stores, API client files, and a minimal `ProjectsPage.vue`.

### What exists

- Backend models for Project, Contribution, ImplementationPlan, Milestone
- CRUD API handlers for projects, contributions, implementation plans
- Contribution registration and assignment endpoints
- Proposal service with status transitions
- Frontend API client functions, Pinia stores with basic CRUD, stub `ProjectsPage.vue`

### What needs building

- **Missing fields** on existing models — sharing/offering/evidence/file fields on `Contribution`; `signed_off` tracking on `ImplementationPlan`; date/status fields on `Milestone`
- **Missing endpoints** — share, offer, accept-offer, sub-contribution approval, plan sign-off, evidence submission, review, contribution sign-off
- **Missing RBAC wire-up** — RBAC infrastructure exists (`rbac.go`, `roles.go`) but handlers do not apply `RBACMiddleware` or `RequireAction`
- **Missing any-sync SSE events** — `TreeUpdateListener` only emits chat events; needs extension for projects/contributions
- **Missing frontend components** — 15+ Vue components from the design reference (4,233+ lines of React/TSX to translate)

---

## 2. Current State Assessment

### Feature Completeness

| Feature | Backend | Frontend | Gap |
|---------|---------|----------|-----|
| Create Project | Exists | API client exists | **Complete** |
| List/Get Projects | Exists | API client exists | **Complete** |
| Link Proposal to Project | Exists | API client exists | **Complete** |
| Create Implementation Plan | Exists | API client exists | **Complete** |
| Add Milestone | Exists | API client exists | **Complete** |
| Create Contribution | Exists | API client exists | **Complete** |
| Transition Status (generic) | Exists | API client exists | **Complete** |
| Register Interest | Exists | No frontend | **Partial** |
| Assign Contribution | Exists | No frontend | **Partial** |
| Confirm Contribution | Missing | Missing | **Missing** |
| Share Contribution | Missing | Missing | **Missing** |
| Offer Contribution | Missing | Missing | **Missing** |
| Accept Offer | Missing | Missing | **Missing** |
| Submit Evidence | Missing | Missing | **Missing** |
| Review Contribution | Missing | Missing | **Missing** |
| Sign Off Contribution | Missing | Missing | **Missing** |
| Sign Off Plan | Missing | Missing | **Missing** |
| Sub-Contribution Hierarchy | Model exists | Missing | **Partial** |
| File Upload for Evidence | Missing | Missing | **Missing** |
| Assign Lead/Steward | Missing | Missing | **Missing** |
| Project Detail UI | N/A | Stub only | **Missing** |
| Milestone Card UI | N/A | Missing | **Missing** |
| Contribution Card UI | N/A | Missing | **Missing** |
| Contribution Detail Dialog | N/A | Missing | **Missing** |

### Existing bugs found

1. `RegisterInterest` guards on `ContribConfirmed` — design requires `ContribShared`
2. `AssignContributor` only accepts `ContribConfirmed` — should also accept `ContribShared`
3. `ContribShared` and `ContribOffered` statuses missing from validation.go constants
4. `Project.Title` JSON tag is `"title"` but frontend design uses `"name"` — needs reconciliation

---

## 3. Data Models (Go Backend)

### 3.1 Contribution struct — extend `internal/contributions/models.go`

Add the following fields to the existing `Contribution` struct:

```go
// Sharing & offering
IsShared          bool       `json:"is_shared,omitempty"`
SharedWithRoles   []string   `json:"shared_with_roles,omitempty"`
ShareLink         string     `json:"share_link,omitempty"`
OfferedTo         string     `json:"offered_to,omitempty"`
OfferedToName     string     `json:"offered_to_name,omitempty"`
OfferedAt         *time.Time `json:"offered_at,omitempty"`

// Interest registration
InterestedContributors []InterestedContributor `json:"interested_contributors,omitempty"`

// Contributor name denormalisation
AssignedContributorName string `json:"assigned_contributor_name,omitempty"`

// Evidence & completion
CompletionNotes   string         `json:"completion_notes,omitempty"`
AcceptanceNotes   []string       `json:"acceptance_notes,omitempty"`
EvidenceURLs      []string       `json:"evidence_urls,omitempty"`
EvidenceFiles     []FileRef      `json:"evidence_files,omitempty"`
TimeReportFile    *FileRef       `json:"time_report_file,omitempty"`
AttachmentFiles   []FileRef      `json:"attachment_files,omitempty"`

// Review (extend existing)
ReviewedAt        *time.Time     `json:"reviewed_at,omitempty"`
```

### 3.2 New types

```go
type FileRef struct {
    FileRef     string `json:"file_ref"`      // CID from FilesHandler
    FileName    string `json:"file_name"`
    ContentType string `json:"content_type"`
    Size        int64  `json:"size,omitempty"`
    Category    string `json:"category"`      // "evidence" | "time_report" | "attachment"
    UploadedBy  string `json:"uploaded_by"`
    UploadedAt  string `json:"uploaded_at"`
}

type InterestedContributor struct {
    UserID       string `json:"user_id"`
    UserName     string `json:"user_name"`
    RegisteredAt string `json:"registered_at"`
    InterestNote string `json:"interest_note"`
}
```

### 3.3 ImplementationPlan struct — extend

```go
type PlanStatus string

const (
    PlanDraft    PlanStatus = "draft"
    PlanActive   PlanStatus = "active"
    PlanArchived PlanStatus = "archived"
)

// Add to ImplementationPlan:
Version          string      `json:"version"`
Status           PlanStatus  `json:"status"`
SignedOff        bool        `json:"signed_off"`
SignedOffBy      string      `json:"signed_off_by,omitempty"`
SignedOffAt      *time.Time  `json:"signed_off_at,omitempty"`
CreatedBy        string      `json:"created_by"`
```

### 3.4 Milestone struct — extend

```go
type MilestoneStatus string

const (
    MilestonePlanned    MilestoneStatus = "planned"
    MilestoneInProgress MilestoneStatus = "in_progress"
    MilestoneCompleted  MilestoneStatus = "completed"
    MilestoneDelayed    MilestoneStatus = "delayed"
)

// Add to Milestone:
ProjectID        string          `json:"project_id"`
Description      string          `json:"description,omitempty"`
StartDate        string          `json:"start_date,omitempty"`
EndDate          string          `json:"end_date,omitempty"`
Status           MilestoneStatus `json:"status"`
SuccessCriteria  []string        `json:"success_criteria,omitempty"`
Dependencies     []string        `json:"dependencies,omitempty"`
BudgetAllocation float64         `json:"budget_allocation,omitempty"`
ActualCost       float64         `json:"actual_cost,omitempty"`
```

### 3.5 Project struct — extend

```go
// Add:
Tags             []string          `json:"tags,omitempty"`
ProjectLeadName  string            `json:"project_lead_name,omitempty"`
StewardName      string            `json:"steward_name,omitempty"`
ProposalMetadata *ProposalMetadata `json:"proposal_metadata,omitempty"`
```

### 3.6 Request/Response types

```go
type ShareContributionRequest struct {
    SharedWithRoles []string `json:"shared_with_roles"`
    ShareLink       string   `json:"share_link,omitempty"`
}

type OfferContributionRequest struct {
    OfferedTo     string `json:"offered_to"`
    OfferedToName string `json:"offered_to_name"`
}

type AcceptOfferRequest struct {
    UserID   string `json:"user_id"`
    UserName string `json:"user_name"`
}

type SubmitEvidenceRequest struct {
    CompletionNotes  string    `json:"completion_notes"`
    AcceptanceNotes  []string  `json:"acceptance_notes,omitempty"`
    EvidenceURLs     []string  `json:"evidence_urls,omitempty"`
    EvidenceFiles    []FileRef `json:"evidence_files,omitempty"`
    TimeReportFile   *FileRef  `json:"time_report_file,omitempty"`
    AttachmentFiles  []FileRef `json:"attachment_files,omitempty"`
    ActualDuration   int       `json:"actual_duration,omitempty"`
}

type ReviewRequest struct {
    Outcome       string `json:"outcome"`        // "approved" | "incomplete" | "declined"
    Feedback      string `json:"feedback,omitempty"`
    QualityRating int    `json:"quality_rating,omitempty"` // 1-10
}

type SignOffPlanRequest struct {
    SignedOffBy string `json:"signed_off_by"`
}
```

---

## 4. API Endpoints

### 4.1 Existing endpoints (already implemented)

| Method | Path | Handler |
|--------|------|---------|
| POST | `/api/v1/projects` | `HandleCreate` |
| GET | `/api/v1/projects` | `HandleList` |
| GET | `/api/v1/projects/{id}` | `HandleGet` |
| PUT | `/api/v1/projects/{id}` | `HandleUpdate` |
| DELETE | `/api/v1/projects/{id}` | `HandleDelete` |
| POST | `/api/v1/projects/{id}/link-proposal` | `HandleLinkProposal` |
| POST | `/api/v1/implementation-plans` | `HandleCreate` |
| GET | `/api/v1/implementation-plans` | `HandleList` |
| GET | `/api/v1/implementation-plans/{id}` | `HandleGet` |
| POST | `/api/v1/implementation-plans/{id}/milestones` | `HandleAddMilestone` |
| POST | `/api/v1/contributions` | `HandleCreate` |
| GET | `/api/v1/contributions` | `HandleList` |
| GET | `/api/v1/contributions/{id}` | `HandleGet` |
| PUT | `/api/v1/contributions/{id}` | `HandleUpdate` |
| POST | `/api/v1/contributions/{id}/transition` | `HandleTransition` |
| POST | `/api/v1/contributions/{id}/register` | `HandleRegister` |
| GET | `/api/v1/contributions/{id}/registrations` | `HandleListRegistrations` |
| POST | `/api/v1/contributions/{id}/assign` | `HandleAssign` |

### 4.2 New endpoints required

| Method | Path | Handler | RBAC Action |
|--------|------|---------|-------------|
| GET | `/api/v1/projects/{id}/contributions` | `HandleListProjectContributions` | none |
| POST | `/api/v1/implementation-plans/{id}/sign-off` | `HandleSignOff` | `ActionSignOffPlan` |
| POST | `/api/v1/contributions/{id}/confirm` | `HandleConfirm` | `ActionConfirmContribution` |
| POST | `/api/v1/contributions/{id}/share` | `HandleShare` | `ActionShareContribution` |
| POST | `/api/v1/contributions/{id}/offer` | `HandleOffer` | `ActionOfferContribution` |
| POST | `/api/v1/contributions/{id}/accept-offer` | `HandleAcceptOffer` | `ActionAcceptOffer` |
| POST | `/api/v1/contributions/{id}/submit-evidence` | `HandleSubmitEvidence` | `ActionSubmitEvidence` |
| POST | `/api/v1/contributions/{id}/review` | `HandleReview` | `ActionReviewContribution` |
| POST | `/api/v1/contributions/{id}/sign-off` | `HandleSignOff` | `ActionSignOffContribution` |
| POST | `/api/v1/contributions/{id}/approve-sub` | `HandleApproveSub` | `ActionApproveContribution` |

### 4.3 Endpoint specifications

**POST `/api/v1/contributions/{id}/confirm`**

Request: `{ "confirmed_by": "EAID456" }`
Response (200): Updated contribution with `status: "confirmed"`
Errors: 400 (wrong status), 403 (insufficient role), 404 (not found)

**POST `/api/v1/contributions/{id}/share`**

Request: `{ "shared_with_roles": ["contributor", "member"], "share_link": "..." }`
Response (200): Updated contribution with `status: "shared"`, `is_shared: true`
Errors: 400 (not confirmed), 403, 404

**POST `/api/v1/contributions/{id}/offer`**

Request: `{ "offered_to": "EAID789", "offered_to_name": "Te Ao Marama" }`
Response (200): Updated contribution with `status: "offered"`
Errors: 400, 403, 404

**POST `/api/v1/contributions/{id}/accept-offer`**

Request: `{ "user_id": "EAID789", "user_name": "Te Ao Marama" }`
Response (200): Updated contribution with `status: "assigned"`
Guard: caller AID must match `contribution.OfferedTo`
Errors: 400, 403 (not offered to you), 404

**POST `/api/v1/contributions/{id}/submit-evidence`**

Request:
```json
{
  "completion_notes": "Completed all interviews...",
  "acceptance_notes": ["Criterion 1 met", "Criterion 2 met"],
  "evidence_urls": ["https://..."],
  "evidence_files": [{ "file_ref": "bafy...", "file_name": "report.pdf", ... }],
  "time_report_file": { "file_ref": "bafy...", ... },
  "actual_duration": 24
}
```
Response (200): Updated contribution with `status: "needs_review"`
Guards: caller must be `assigned_contributor`; all children must be `signed_off`
Errors: 400 (blocking children — returns `{ "error": "...", "blocking_contributions": ["id1"] }`), 403, 404

**POST `/api/v1/contributions/{id}/review`**

Request: `{ "outcome": "approved", "feedback": "...", "quality_rating": 9 }`
Response (200): Updated contribution
Outcome mapping: `"approved"` → `approved`, `"incomplete"` → `assigned`, `"declined"` → `archived`
Errors: 400, 403, 404

**POST `/api/v1/contributions/{id}/sign-off`**

Request: `{ "signed_off_by": "EAID456" }`
Response (200): Updated contribution with `status: "signed_off"`
Errors: 400 (not approved), 403, 404

**POST `/api/v1/contributions/{id}/approve-sub`**

Request: `{ "approved_by": "EAID123" }`
Response (200): Sub-contribution with `status: "assigned"`, auto-assigned to parent's contributor
Guards: must be a sub-contribution (`parent_contribution` set), status must be `created`
Errors: 400, 403, 404

**POST `/api/v1/implementation-plans/{id}/sign-off`**

Request: `{ "signed_off_by": "EAID456" }`
Response (200): Updated plan with `signed_off: true`
Validation: at least one milestone, every milestone has contributions, all contributions `confirmed`
Errors: 400 (with detail), 403, 404, 409 (already signed off)

---

## 5. RBAC & Permission Logic

### 5.1 Updated permission matrix

| Action | Community Admin | Project Steward | Project Lead | Contributor | Member |
|--------|----------------|----------------|-------------|-------------|--------|
| Create Project | Yes | No | No | No | No |
| Edit Project | Yes | No | Yes | No | No |
| Create Contribution (parent) | Yes | No | Yes | No | No |
| Create Sub-Contribution | Yes | No | Yes | Yes (if assigned to parent) | No |
| Confirm Contribution | Yes | Yes | No | No | No |
| Share Contribution | Yes | Yes | Yes | No | No |
| Offer Contribution | Yes | Yes | Yes | No | No |
| Register Interest | No | No | No | Yes | Yes |
| Accept Offer | No | No | No | Yes | Yes |
| Submit Evidence | Yes | No | No | Yes (if assigned) | No |
| Review Submission | Yes | No | Yes | No | No |
| Approve Sub-Contribution | Yes | No | Yes | No | No |
| Sign Off Contribution | Yes | Yes | No | No | No |
| Sign Off Plan | Yes | Yes | No | No | No |

### 5.2 Action constants — add to `roles.go`

```go
ActionShareContribution    Action = "share_contribution"
ActionOfferContribution    Action = "offer_contribution"
ActionAcceptOffer          Action = "accept_offer"
ActionSubmitEvidence       Action = "submit_evidence"
ActionReviewContribution   Action = "review_contribution"
ActionSignOffPlan          Action = "sign_off_plan"
```

### 5.3 Dynamic/contextual guards (enforced inside service, not middleware)

- **Sub-contribution creation**: contributor must be `assigned_contributor` on parent; parent must be in `assigned` status; parent cannot itself be a sub-contribution (flat hierarchy)
- **Accept offer**: caller AID must match `contribution.OfferedTo`
- **Submit evidence**: caller must be `assigned_contributor`; all children must be `signed_off`/`rewarded`/`archived`
- **Plan sign-off**: all contributions in all milestones must be `confirmed`

---

## 6. Status Transition Machine

### 6.1 Parent contribution transitions

```go
var contributionTransitions = map[ContributionStatus][]ContributionStatus{
    ContribCreated:     {ContribConfirmed},
    ContribConfirmed:   {ContribShared, ContribOffered, ContribAssigned},
    ContribShared:      {ContribOffered, ContribAssigned},
    ContribOffered:     {ContribAssigned, ContribConfirmed},  // accept or decline
    ContribAssigned:    {ContribChanged, ContribNeedsReview},
    ContribChanged:     {ContribConfirmed},
    ContribNeedsReview: {ContribApproved, ContribIncomplete, ContribDeclined},
    ContribIncomplete:  {ContribAssigned},  // back to contributor
    ContribApproved:    {ContribSignedOff},
    ContribSignedOff:   {ContribRewarded},
    ContribRewarded:    {ContribArchived},
    ContribDeclined:    {ContribArchived},
}
```

### 6.2 Sub-contribution transitions

```
created → assigned (via approve-sub, auto-assigned to parent's contributor)
created → archived (via decline)
assigned → needs_review (submit evidence)
needs_review → approved | assigned (incomplete) | archived (declined)
approved → signed_off
```

No `confirmed`, `shared`, or `offered` states for sub-contributions.

### 6.3 Transition trigger table

| From → To | Who triggers | Endpoint |
|-----------|-------------|----------|
| `created` → `confirmed` | Steward / Admin | `/confirm` |
| `confirmed` → `shared` | Lead / Steward / Admin | `/share` |
| `confirmed` → `offered` | Lead / Steward / Admin | `/offer` |
| `confirmed` → `assigned` | Lead / Admin | `/assign` |
| `shared` → `offered` | Lead / Steward / Admin | `/offer` |
| `shared` → `assigned` | Lead / Admin | `/assign` |
| `offered` → `assigned` | Member / Contributor | `/accept-offer` |
| `offered` → `confirmed` | System (decline) | `/transition` |
| `assigned` → `needs_review` | Assigned contributor | `/submit-evidence` |
| `needs_review` → `approved` | Lead / Admin | `/review` (outcome=approved) |
| `needs_review` → `assigned` | Lead / Admin | `/review` (outcome=incomplete) |
| `needs_review` → `archived` | Lead / Admin | `/review` (outcome=declined) |
| `approved` → `signed_off` | Steward / Admin | `/sign-off` |
| `signed_off` → `rewarded` | System (treasury) | `/transition` |

---

## 7. Business Logic

### 7.1 Plan sign-off validation

```go
func canSignOffPlan(plan ImplementationPlan, allContribs []Contribution) error {
    if plan.SignedOff { return ErrPlanAlreadySignedOff }
    if len(plan.Milestones) == 0 { return errors.New("plan must have at least one milestone") }

    for _, m := range plan.Milestones {
        if len(m.ContributionIDs) == 0 {
            return fmt.Errorf("milestone %s has no contributions", m.MilestoneID)
        }
    }

    // All contributions must be confirmed
    for _, c := range allContribs {
        if c.Status != ContribConfirmed {
            return fmt.Errorf("contribution %s is %s, must be confirmed", c.ID, c.Status)
        }
    }
    return nil
}
```

### 7.2 Parent contribution blocking

A parent contribution cannot be submitted for review until all child contributions are `signed_off`, `rewarded`, or `archived`.

### 7.3 Sub-contribution auto-assignment

When a sub-contribution is approved (`HandleApproveSub`), the service fetches the parent contribution and copies `parent.AssignedContributorID` and `parent.AssignedContributorName` to the child.

### 7.4 Atomic child linking

When creating a sub-contribution, the service must also update the parent's `ChildContributionIDs` slice. The authoritative relationship is `child.ParentContributionID`; `parent.ChildContributionIDs` is a convenience cache.

---

## 8. Any-Sync Data Layer

### 8.1 Architecture note

The design documentation describes a "parent tree" hierarchy. **This hierarchy does not exist in any-sync.** The SDK stores all trees as peers in a flat space. "Hierarchy" is expressed solely as data fields — a `projectId` field stored inside a contribution tree is the only thing linking them.

The existing codebase already handles this correctly. The `notice_tree.go` pattern (e.g., `NoticeComment` stores `noticeId` as a field) is the model to follow.

### 8.2 Object tree type constants

Already declared in `object_tree.go`:

```go
TypeProject            = "project"
TypeImplementationPlan = "implementation_plan"
TypeMilestone          = "milestone"
TypeContribution       = "contribution"
```

Sub-contributions reuse `TypeContribution` with a `parentId` field. `GetTreesByType(spaceID, "contribution")` returns everything; callers filter by `parentId`.

### 8.3 Object IDs

```
project:{uuid}
plan:{uuid}
milestone:{uuid}
contribution:{uuid}
```

### 8.4 Interest registration — stored within contribution tree

Interests are stored as a JSON array field (`interests`) on the contribution's own tree, not as separate trees. When a new interest is registered, the current array is read, appended to, and written back via `Save`. This produces one `set` op.

```go
type InterestRecord struct {
    UserID       string `json:"userId"`
    Statement    string `json:"statement"`
    RegisteredAt string `json:"registeredAt"`
}
```

### 8.5 File references — stored within contribution tree

File references are stored in three JSON array fields: `evidenceFiles`, `timeReports`, `attachments`. Pattern identical to interests: read-modify-write.

```go
type FileReference struct {
    CID         string `json:"cid"`
    Name        string `json:"name"`
    ContentType string `json:"contentType"`
    Category    string `json:"category"`
    UploadedBy  string `json:"uploadedBy"`
    UploadedAt  string `json:"uploadedAt"`
}
```

### 8.6 Extend ObjectStoreAdapter — `contrib_adapter.go`

Add two new methods:

```go
func (a *ObjectStoreAdapter) RegisterInterest(spaceID, contribID, userID, statement string) error
func (a *ObjectStoreAdapter) AttachFile(spaceID, contribID string, ref FileReference) error
```

Both follow the same read-modify-write pattern on JSON array fields.

### 8.7 ACL note

All projects and contributions live in the **community space**. The community ACL grants `PermissionWrite` to any membership credential holder. Role-based restrictions (only steward can sign off, etc.) are enforced at the **application layer** by `contributions.Service`, not by any-sync ACL.

### 8.8 Sync — no changes needed

The `matouTreeSyncer` handles all P2P sync transparently. `extractIndexEntry` already recognises `ObjectChangeType` trees and will correctly index contribution, project, milestone, and plan trees.

---

## 9. File Storage

### 9.1 Upload flow

Uses existing `FilesHandler` (`POST /api/v1/files/upload`). No new upload endpoints required.

1. Frontend uploads file to `POST /api/v1/files/upload` (multipart)
2. Backend stores in any-sync file node, returns `{ "fileRef": "bafy...", "contentType": "...", "size": "..." }`
3. Frontend includes `FileRef` objects in the `submit-evidence` request body
4. Backend saves `FileRef` CIDs on the Contribution struct

### 9.2 File retrieval

Files retrieved via existing `GET /api/v1/files/{cid}`. Frontend constructs download URL from stored `file_ref` field.

### 9.3 Validation limits

- Max 10 `evidence_files` per submission
- Max 1 `time_report_file`
- Max 5 `attachment_files`

---

## 10. SSE & Real-Time Events

### 10.1 Extend TreeUpdateListener — `tree_listener.go`

Add cases in `processChanges` for `"project"`, `"contribution"`, `"milestone"`, `"implementation_plan"` object types. Extract a reusable `extractJSONField` helper.

### 10.2 SSE event catalogue

| Handler | SSE Event Type | Key Data |
|---------|---------------|----------|
| Create project | `project:created` | `project_id, name, status` |
| Create contribution | `contribution:created` | `contribution_id, project_id, title, status` |
| Confirm | `contribution:confirmed` | `contribution_id, project_id` |
| Share | `contribution:shared` | `contribution_id, shared_with_roles` |
| Offer | `contribution:offered` | `contribution_id, offered_to` |
| Accept offer | `contribution:accepted` | `contribution_id, assigned_contributor` |
| Assign | `contribution:assigned` | `contribution_id, assigned_contributor` |
| Submit evidence | `contribution:submitted` | `contribution_id, project_id` |
| Review | `contribution:reviewed` | `contribution_id, outcome` |
| Sign off (contrib) | `contribution:signed_off` | `contribution_id, signed_off_by` |
| Approve sub | `sub_contribution:approved` | `contribution_id, parent_id` |
| Sign off (plan) | `plan:signed_off` | `plan_id, project_id` |
| Register interest | `contribution:interest_registered` | `contribution_id, user_id` |

### 10.3 Inject EventBroker

Add `broker *EventBroker` field to `ContributionsHandler` and `ImplementationPlansHandler`, following the existing `ProposalsHandler` pattern.

---

## 11. Frontend TypeScript Types

Create `frontend/src/types/projects.ts`:

```typescript
export type ProjectStatus = 'created' | 'active' | 'completed' | 'archived';

export type ContributionStatus =
  | 'created' | 'confirmed' | 'shared' | 'offered' | 'assigned'
  | 'changed' | 'needs_review' | 'approved' | 'incomplete'
  | 'declined' | 'signed_off' | 'rewarded' | 'archived';

export type ContributionType = 'governance' | 'technical' | 'cultural' | 'community';
export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type ProjectRole = 'community_admin' | 'project_lead' | 'project_steward' | 'contributor' | 'member';

export interface InterestedContributor {
  user_id: string;
  user_name: string;
  registered_at: string;
  interest_note: string;
}

export interface AttachedFile {
  name: string;
  url: string;
  type: string;
}

export interface Contribution {
  id: string;
  project_id: string;
  milestone_id: string;
  title: string;
  description: string;
  contribution_type: ContributionType;
  priority: Priority;
  status: ContributionStatus;
  version: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  estimated_duration: number;
  actual_duration: number;
  deadline?: string;
  objectives: string[];
  deliverables: string[];
  acceptance_criteria: string[];
  skill_requirements: string[];
  eligible_roles: string[];
  tags: string[];
  parent_contribution?: string;
  child_contributions: string[];
  assigned_contributor?: string;
  assigned_contributor_name?: string;
  is_shared?: boolean;
  shared_with_roles?: string[];
  share_link?: string;
  offered_to?: string;
  offered_to_name?: string;
  offered_at?: string;
  interested_contributors?: InterestedContributor[];
  completion_notes?: string;
  acceptance_notes?: string[];
  evidence_urls?: string[];
  time_report_file?: AttachedFile;
  attachment_files?: AttachedFile[];
  review_outcome?: 'approved' | 'rejected' | 'revision_required';
  review_feedback?: string;
  quality_rating?: number;
  reviewed_by?: string;
  reviewed_at?: string;
  signed_off_by?: string;
  signed_off_at?: string;
}

export interface Milestone {
  milestone_id: string;
  implementation_plan_id: string;
  project_id: string;
  title: string;
  description?: string;
  duration: string;
  start_date?: string;
  end_date?: string;
  status: 'planned' | 'in_progress' | 'completed' | 'delayed';
  contributions: Contribution[];
}

export interface ImplementationPlan {
  id: string;
  project_id: string;
  version: string;
  total_budget: string;
  milestones: Milestone[];
  status: 'draft' | 'active' | 'archived';
  signed_off: boolean;
  signed_off_by?: string;
  signed_off_at?: string;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  status: ProjectStatus;
  images: Array<{ image_id: string; url: string; type: string; alt_text?: string }>;
  proposal_ids: string[];
  implementation_plan_ids: string[];
  project_steward_id?: string;
  project_lead_id?: string;
  project_lead_name?: string;
  steward_name?: string;
  tags?: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}
```

---

## 12. Pinia Store Design

### 12.1 Extend `useProjectsStore`

**Additional state:**

```typescript
const implementationPlans = ref<Record<string, ImplementationPlan>>({});
```

**Additional getters:**

```typescript
const allContributions = computed(() =>
  Object.values(implementationPlans.value)
    .flatMap(plan => plan.milestones.flatMap(m => m.contributions))
);

const planProgressByProject = computed(() => {
  const map: Record<string, { total: number; confirmed: number; pct: number }> = {};
  // Calculate confirmation progress per project
  return map;
});
```

**Additional actions:**

```typescript
async function fetchImplementationPlan(projectId: string): Promise<ImplementationPlan | null>
async function createPlan(projectId: string, budget: string): Promise<ImplementationPlan>
async function addMilestone(planId: string, req: CreateMilestoneRequest): Promise<ImplementationPlan>
async function signOffPlan(planId: string): Promise<ImplementationPlan>
async function assignRole(req: AssignRoleRequest): Promise<Project>
function patchContributionInPlan(projectId: string, updated: Contribution): void
```

The `patchContributionInPlan` function is critical — contributions are nested inside milestones inside plans, and the entire sub-tree must be updated immutably for Vue reactivity:

```typescript
function patchContributionInPlan(projectId: string, updated: Contribution) {
  const plan = implementationPlans.value[projectId];
  if (!plan) return;
  implementationPlans.value[projectId] = {
    ...plan,
    milestones: plan.milestones.map(m => ({
      ...m,
      contributions: m.contributions.map(c => c.id === updated.id ? updated : c)
    }))
  };
}
```

### 12.2 Extend `useContributionsStore`

**Additional actions (workflow transitions):**

```typescript
async function confirm(id: string): Promise<Contribution>
async function share(id: string, req: ShareContributionRequest): Promise<Contribution>
async function offer(id: string, req: OfferContributionRequest): Promise<Contribution>
async function accept(id: string): Promise<Contribution>
async function decline(id: string): Promise<Contribution>
async function registerInterest(id: string, req: RegisterInterestRequest): Promise<Contribution>
async function submitEvidence(id: string, req: SubmitEvidenceRequest): Promise<Contribution>
async function submitReview(id: string, req: SubmitReviewRequest): Promise<Contribution>
async function signOff(id: string): Promise<Contribution>
async function createChildContribution(parentId: string, req: CreateContributionRequest): Promise<{ child: Contribution; parent: Contribution }>
async function approveSub(id: string): Promise<Contribution>
```

---

## 13. Vue Component Inventory

All components go under `frontend/src/components/projects/`.

### 13.1 ProjectsListView.vue

**Maps from:** `ProjectsScreen.tsx`
**Purpose:** Project list/grid with search, status filter, and project cards.
**Props:** `currentUser?: CurrentUser`
**Emits:** `select-project`, `create-project`
**Key features:** Search by title/description, status filter tabs (All/Active/Completed/Archived), grid layout `grid-cols-1 lg:grid-cols-2 gap-4`, empty state with `Rocket` icon.

### 13.2 ProjectCard.vue

**Maps from:** Project card block in `ProjectsScreen.tsx`
**Props:** `project: Project`, `sharedContributions?: Contribution[]`, `currentUser?: CurrentUser`
**Emits:** `click`
**Key features:** Status badge, lead/steward indicators, shared contributions preview (first 3 + "+N more"), hover shadow.

### 13.3 ProjectDetailView.vue

**Maps from:** `ProjectDetail.tsx` (1316 lines)
**Props:** `project: Project`, `implementationPlan?: ImplementationPlan`, `currentUser?: CurrentUser`
**Emits:** `back`, `update`, `view-proposal`
**Key sections:**
- Back button + project header with title, description, team chips
- Team assignment chips: Lead (`Shield` icon, chart-2 colour), Steward (`Users` icon, accent colour)
- Linked proposals section (clickable cards with budget/timeline chips)
- Sign-off banner (shown when all contributions confirmed)
- Confirmation progress bar (`QLinearProgress`)
- Plan signed-off badge
- Milestones list (or empty state)

### 13.4 MilestoneCard.vue

**Maps from:** `MilestoneCard.tsx` (243 lines)
**Props:** `milestone`, `milestoneNumber`, `projectId`, `canEdit`, `canConfirm`, `isPlanSignedOff`, `userRole`, `currentUser`, `allContributions`
**Emits:** `update`, `create-contribution`, `create-child-contribution`
**Key features:** Expand/collapse toggle, "All Confirmed" badge, "Locked" badge (when signed off), signed-off visual inversion (primary bg + white text), contribution list, "Add Contribution" button, empty state.

### 13.5 ContributionCard.vue

**Maps from:** `ContributionCard.tsx` (573 lines)
**Props:** `contribution`, `canConfirm`, `isPlanSignedOff`, `userRole`, `currentUserId`, `currentUserName`, `allContributions`
**Emits:** `update`, `create-contribution`, `create-child-contribution`
**Key features:** Title + type/priority/status badges, conditional action buttons (Confirm, Share, Offer, View Details), edit mode (inline), assigned member chip, offered/shared status notices, sub-contributions preview section, click opens `ContributionDetailDialog`.

### 13.6 ContributionDetailDialog.vue

**Maps from:** `ContributionDetailDialog.tsx` (1211 lines — most complex component)
**Props:** `modelValue: boolean`, `contribution`, `userRole`, `currentUserId`, `currentUserName`, `allContributions`
**Emits:** `update:modelValue`, `update`, `create-contribution`, `create-child-contribution`
**Key sections:**
1. Sticky header (title, badges, close)
2. Offered/shared/pending-approval status panels
3. Interested contributors list (with offer buttons)
4. Description, objectives, deliverables, acceptance criteria, skill requirements
5. Assignment info
6. Sub-contributions section with "Add Sub-Contribution" button
7. Blocking warning (when children not signed off)
8. Evidence submission form (notes, URLs, file uploads, hours)
9. Review form (outcome toggle, quality rating 1-10, feedback)
10. Sign-off panel
11. Footer actions (Share, Offer, Register Interest, Accept/Decline)
12. Sub-dialogs: Share, Offer, Interest, Offer Confirmation

### 13.7 CreateProjectDialog.vue

**Maps from:** `CreateProjectDialog.tsx` (124 lines)
**Props:** `modelValue`, `proposalId?`, `proposalTitle?`, `proposalDescription?`
**Form fields:** Title (required), Description (textarea, required), proposal link notice.

### 13.8 AddMilestoneDialog.vue

**Maps from:** `AddMilestoneDialog.tsx` (185 lines)
**Props:** `modelValue`, `projectId`, `implementationPlanId`
**Form fields:** Title (required), Duration (required), inline contribution staging with nested `CreateContributionDialog`.

### 13.9 CreateContributionDialog.vue

**Maps from:** `CreateContributionDialog.tsx` (472 lines)
**Props:** `modelValue`, `projectId`, `milestoneId`, `parentContributionId?`, `userRole?`
**Form sections:**
1. Title (required)
2. Description (textarea, required)
3. Type selector (2x2 button grid: Governance/Technical/Cultural/Community)
4. Priority selector (2x2 button grid: Low/Medium/High/Critical)
5. Duration & Deadline (2-col grid)
6. Objectives (dynamic list, min 1 required)
7. Deliverables (dynamic list, min 1 required)
8. Acceptance Criteria (dynamic list, optional)
9. Skill Requirements (dynamic list, optional)

### 13.10 AssignRoleDialog.vue

**Maps from:** `AssignRoleDialog.tsx` (109 lines)
**Props:** `modelValue`, `role: 'lead' | 'steward'`
**Features:** Search input, scrollable member list (max-h-256), selection highlight, role-specific icon/colour (Shield+chart-2 for lead, Users+accent for steward).

### 13.11 Badge components (reusable)

- **ContributionStatusBadge.vue** — renders pill badge with status-specific colours
- **ContributionTypeBadge.vue** — renders pill badge with type-specific colours
- **PriorityBadge.vue** — renders pill badge with priority-specific colours

---

## 14. Frontend Pages & Routes

No new routes required. `ProjectsPage.vue` manages internal state (`selectedProject` ref) to toggle between list and detail views:

```vue
<template>
  <ProjectDetailView v-if="selectedProject" ... @back="selectedProject = null" />
  <ProjectsListView v-else ... @select-project="handleSelect" />
  <CreateProjectDialog v-model="showCreateDialog" @created="handleCreated" />
</template>
```

The existing route `/dashboard/projects` remains correct.

---

## 15. API Client Functions

### 15.1 Extend `frontend/src/lib/api/contributions.ts`

```typescript
export async function shareContribution(id: string, req: ShareContributionRequest): Promise<Contribution>
export async function offerContribution(id: string, req: OfferContributionRequest): Promise<Contribution>
export async function registerInterest(id: string, req: RegisterInterestRequest): Promise<Contribution>
export async function submitEvidence(id: string, req: SubmitEvidenceRequest): Promise<Contribution>
export async function submitReview(id: string, req: SubmitReviewRequest): Promise<Contribution>
export async function signOffContribution(id: string): Promise<Contribution>
export async function createChildContribution(parentId: string, req: CreateContributionRequest): Promise<{ child: Contribution; parent: Contribution }>
export async function approveSub(id: string): Promise<Contribution>
export async function confirmContribution(id: string): Promise<Contribution>
```

### 15.2 Extend `frontend/src/lib/api/implementationPlans.ts`

```typescript
export async function getImplementationPlanForProject(projectId: string): Promise<ImplementationPlan | null>
export async function signOffImplementationPlan(planId: string): Promise<ImplementationPlan>
```

### 15.3 Extend `frontend/src/lib/api/projects.ts`

```typescript
export async function assignProjectRole(projectId: string, role: 'lead' | 'steward', userId: string): Promise<Project>
export async function listProjectContributions(projectId: string): Promise<Contribution[]>
```

---

## 16. Composables

### 16.1 `useContributionWorkflow.ts` (new)

Encapsulates the status transition permission matrix:

```typescript
export function useContributionWorkflow() {
  function canShare(contribution: Contribution, role: ProjectRole): boolean
  function canOffer(contribution: Contribution, role: ProjectRole): boolean
  function canRegisterInterest(contribution: Contribution, role: ProjectRole, currentUserId: string): boolean
  function canAccept(contribution: Contribution, currentUserId: string): boolean
  function canSubmitEvidence(contribution: Contribution, currentUserId: string, allChildrenSignedOff: boolean): boolean
  function canReview(contribution: Contribution, role: ProjectRole): boolean
  function canSignOff(contribution: Contribution, role: ProjectRole): boolean
  function canConfirm(contribution: Contribution, isPlanSignedOff: boolean, role: ProjectRole): boolean
  function canAddSubContribution(contribution: Contribution, currentUserId: string, role: ProjectRole): boolean
  return { canShare, canOffer, canRegisterInterest, canAccept, canSubmitEvidence, canReview, canSignOff, canConfirm, canAddSubContribution }
}
```

### 16.2 `useProjectPermissions.ts` (new)

```typescript
export function useProjectPermissions(project: Ref<Project | null>, currentUser: Ref<CurrentUser>) {
  const isAdmin = computed(() => currentUser.value?.role === 'admin')
  const canCreateProject = computed(() => isAdmin.value)
  const canAssignRoles = computed(() => isAdmin.value)
  const canAddMilestones = computed(() => isAdmin.value && project.value?.status !== 'archived')
  const canSignOffPlan = computed(() => isAdmin.value)
  return { isAdmin, canCreateProject, canAssignRoles, canAddMilestones, canSignOffPlan }
}
```

---

## 17. UI/UX Specification

### 17.1 Status badge colours

| Status | Background | Text |
|--------|-----------|------|
| created | muted | muted-foreground |
| confirmed | accent/10 | accent |
| shared | accent/10 | accent |
| offered | primary/10 | primary |
| assigned | accent/10 | accent |
| needs_review | chart-1/10 | chart-1 |
| approved | accent/10 | accent |
| incomplete | chart-1/10 | chart-1 |
| declined | destructive/10 | destructive |
| signed_off | accent/10 | accent |
| rewarded | accent/10 | accent |
| archived | muted | muted-foreground |

### 17.2 Contribution type colours

| Type | Background | Text |
|------|-----------|------|
| governance | chart-2/10 | chart-2 |
| technical | primary/10 | primary |
| cultural | accent/10 | accent |
| community | chart-1/10 | chart-1 |

### 17.3 Priority colours

| Priority | Background | Text |
|----------|-----------|------|
| low | muted | muted-foreground |
| medium | chart-2/10 | chart-2 |
| high | chart-1/10 | chart-1 |
| critical | destructive/10 | destructive |

### 17.4 Toast notifications

| Action | Type | Message |
|--------|------|---------|
| Project created | positive | "Project created successfully!" |
| Milestone added | positive | "Milestone added successfully!" |
| Contribution confirmed | positive | "Contribution confirmed!" |
| Shared | positive | "Contribution shared successfully!" |
| Offered | positive | "Contribution offered to {name}" |
| Interest registered | positive | "Interest registered successfully!" |
| Accepted | positive | "Contribution accepted!" |
| Declined | info | "Contribution declined" |
| Review submitted | positive | "Review submitted!" |
| Submitted for review | positive | "Submitted for review!" |
| Signed off (contrib) | positive | "Contribution signed off! Treasury action will be generated." |
| Sub approved | positive | "Sub-contribution approved and assigned!" |
| Plan signed off | positive | "Implementation plan signed off!" |
| Validation error | negative | "{specific message}" |

### 17.5 Milestone signed-off visual state

When `isPlanSignedOff = true`, milestone cards flip to primary-colour-filled state: `background: var(--matou-primary); color: var(--matou-primary-foreground)`.

### 17.6 Quality rating (review form)

10 `Star` icons from lucide-vue-next. Filled state: `fill-accent text-accent`. Unfilled: `text-muted-foreground`. Clicking sets the rating.

### 17.7 Empty states

- Projects list: `Rocket` icon (48px, muted/50), "No projects found"
- Milestones: `Clock` icon (48px, muted/50), "No milestones yet"
- Contributions in milestone: `AlertCircle` icon (40px, muted/50), "No contributions in this milestone yet"
- Sub-contributions: "No sub-contributions yet. Break down this contribution into smaller tasks."

### 17.8 Dialog sizing

`ContributionDetailDialog` and `CreateContributionDialog`: `max-w-3xl w-full max-h-[90vh] overflow-y-auto`. Sticky header/footer with `position: sticky`.

---

## 18. E2E Test Plan

**Prerequisites:** 3 community members:
- **Founding Member** (community admin) — full admin privileges
- **Member 1** (approved) — assigned as project lead
- **Member 2** (approved) — assigned as contributor

### Test 1: Proposal creation and project setup

- Admin creates proposal, assigns self as steward, Member 1 as lead
- Both members can navigate to projects and see the new project in draft

### Test 2: Implementation plan and contribution confirmation

- Member 1 (lead) creates plan with 2 milestones, each with contributions
- Member 1 edits a contribution
- Founding member (steward) confirms all contributions
- Steward signs off the plan

### Test 3: Share, offer, register, accept

- Lead shares a contribution
- Lead offers another contribution to Member 2
- Member 2 registers interest in shared contribution
- Member 2 accepts the offered contribution

### Test 4: Sub-contribution creation and approval

- Member 2 creates a sub-contribution on their assigned contribution
- Lead approves the sub-contribution (auto-assigned to Member 2)

### Test 5: Completion, review, and sign-off

- Member 2 completes sub-contribution (submit evidence)
- Lead reviews and approves sub-contribution
- Steward signs off sub-contribution
- Member 2 submits evidence on parent contribution (now unblocked)
- Lead reviews and approves parent
- Steward signs off parent

### Test 6: Edge cases

- Member cannot create project (no Create Proposal button visible)
- Lead cannot sign off contributions (no Sign Off button visible)
- Unassigned member cannot submit evidence
- Parent blocked when sub-contributions incomplete
- Plan cannot be signed off without all contributions confirmed
- Cannot share an unconfirmed contribution

---

## 19. Backend Test Plan

### 19.1 Unit tests — `internal/contributions`

**validation_test.go:**
- `TestContributionTransitions_SharedOffered` — verify shared/offered transitions
- `TestValidateParentSignOff_BlockingChild` — parent blocked
- `TestValidatePlanSignOff_EmptyMilestone` — rejected
- `TestValidatePlanSignOff_UnconfirmedContribution` — rejected
- `TestValidatePlanSignOff_AllConfirmed` — passes

**service_test.go:**
- `TestService_ShareContribution`
- `TestService_OfferContribution`
- `TestService_AcceptOffer_HappyPath` and `_WrongUser`
- `TestService_SubmitEvidence_NoChildren` and `_BlockedByChild` and `_ChildrenSignedOff`
- `TestService_ReviewContribution_Approved`, `_Incomplete`, `_Declined`
- `TestService_SignOffContribution`
- `TestService_ApproveSubContribution`
- `TestService_SignOffPlan_HappyPath` and `_UnconfirmedBlocked`
- `TestService_CreateContribution_SubLinksParent`
- `TestService_CreateContribution_SubFlatHierarchy` (sub of sub rejected)

### 19.2 Handler tests — `internal/api`

- `TestContributionsHandler_Confirm`, `_Share`, `_Offer`, `_AcceptOffer`
- `TestContributionsHandler_SubmitEvidence` and `_SubmitEvidence_BlockedByChild`
- `TestContributionsHandler_Review_Approved` and `_Incomplete`
- `TestContributionsHandler_SignOff`, `_ApproveSub`
- `TestContributionsHandler_RBAC_Forbidden`
- `TestImplementationPlansHandler_SignOff_HappyPath`, `_AlreadySigned`, `_UnconfirmedContribs`

### 19.3 Integration tests

- Full contribution lifecycle (create → confirm → sign-off plan → share → register → offer → accept → evidence → review → sign-off)
- Sub-contribution blocks parent
- RBAC enforcement end-to-end

### 19.4 Any-sync layer tests

- `TestObjectStoreAdapter_RegisterInterest_Appends`
- `TestObjectStoreAdapter_AttachFile_AppendsToCorrectField`
- `TestObjectStoreAdapter_List_ByType`
- `TestContributionFields_RoundTrip`

---

## 20. Implementation Stages

### Stage 1: Model & Validation Foundation

**Files:** `internal/contributions/models.go`, `validation.go`, `roles.go`
**Work:**
- Add `ContribShared`, `ContribOffered` status constants
- Add `PlanStatus` type, update `ImplementationPlan` with signed-off fields
- Update `Milestone` with date/status/criteria fields
- Add `FileRef`, `InterestedContributor` types
- Add sharing/offering/evidence/file fields to `Contribution`
- Extend `contributionTransitions` map
- Add `planTransitions` map, `ValidatePlanSignOff` function
- Add new `Action` constants, update `actionPermissions` map
- Write unit tests

**No breaking changes to existing handlers.**

### Stage 2: Service Layer

**Files:** `internal/contributions/service.go`
**Work:**
- Implement `ConfirmContribution`, `ShareContribution`, `OfferContribution`, `AcceptOffer`
- Implement `SubmitEvidence` (with `BlockingChildrenError`), `ReviewContribution`, `SignOffContribution`
- Implement `ApproveSubContribution`, `SignOffPlan` (with `UnconfirmedContributionsError`)
- Fix `RegisterInterest` to use `ContribShared`
- Update `CreateContribution` to link sub-contribs to parent atomically
- Add `ListContributionsByProject`
- Write service unit tests

**Depends on:** Stage 1

### Stage 3: Handler Extensions

**Files:** `internal/api/contributions_handler.go`
**Work:**
- Add `roleLookup` and `broker` fields
- Implement all 8 new handlers (confirm, share, offer, accept-offer, submit-evidence, review, sign-off, approve-sub)
- Tighten `HandleUpdate` to typed request
- Extend route registration
- Write handler tests

**Depends on:** Stage 2

### Stage 4: Plan Sign-Off Handler

**Files:** `internal/api/implementation_plans.go`
**Work:**
- Add `broker` field
- Implement `HandleSignOff` with validation
- Write tests

**Depends on:** Stages 2-3

### Stage 5: Project Handler Extensions

**Files:** `internal/api/projects.go`
**Work:**
- Add RBAC middleware
- Implement `HandleListProjectContributions`
- Broadcast SSE events
- Write tests

**Depends on:** Stage 2

### Stage 6: Any-Sync Extensions

**Files:** `internal/anysync/contrib_adapter.go`, `tree_listener.go`
**Work:**
- Add `RegisterInterest`, `AttachFile` methods to adapter
- Extend `TreeUpdateListener.processChanges` for contribution/project SSE
- Extract `extractJSONField` helper
- Write unit + integration tests

**Depends on:** Stage 3

### Stage 7: Backend Wiring

**Files:** `cmd/server/main.go`
**Work:**
- Pass `roleLookup` to all handlers
- Call `SetBroker` on contribution and plan handlers
- Verify all routes registered

**Depends on:** Stages 3-6

### Stage 8: Frontend Foundation

**Files:** `types/projects.ts`, `lib/api/*.ts`, stores, composables
**Work:**
- Create types file
- Extend API client functions
- Extend Pinia stores with workflow actions
- Create `useContributionWorkflow` and `useProjectPermissions` composables

**Can start in parallel with backend stages.**

### Stage 9: Frontend Badge & Dialog Components

**Files:** `components/projects/*.vue`
**Work:**
- Build badge components (Status, Type, Priority)
- Build `CreateProjectDialog`, `CreateContributionDialog`, `AssignRoleDialog`, `AddMilestoneDialog`

**Depends on:** Stage 8

### Stage 10: Frontend Workflow Components

**Files:** `components/projects/*.vue`
**Work:**
- Build `ContributionDetailDialog` (most complex — build in sub-sections)
- Build `ContributionCard`
- Build `MilestoneCard`

**Depends on:** Stage 9

### Stage 11: Frontend Top-Level Views

**Files:** `components/projects/*.vue`, `pages/ProjectsPage.vue`
**Work:**
- Build `ProjectDetailView`, `ProjectCard`, `ProjectsListView`
- Rewrite `ProjectsPage.vue` to orchestrate list/detail toggle

**Depends on:** Stage 10

### Stage 12: E2E Tests

**Files:** `frontend/tests/*.spec.ts`
**Work:**
- Write all 6 E2E test scenarios from section 18

**Depends on:** All stages

### Stage 13: Integration Testing & Polish

**Work:**
- End-to-end integration testing against real test network
- Error handling and loading states
- Responsiveness verification
- API documentation update (`backend/docs/API.md`)

**Depends on:** All stages

---

## 21. Risk Register

### Critical risks

| Risk | Mitigation |
|------|-----------|
| Implementation plan lifecycle not implemented | Stage 4 — implement sign-off handler early |
| Sub-contribution hierarchy incomplete | Stage 2 — atomic child linking in service |
| No file upload for evidence | Existing `FilesHandler` works — just wire it |
| Share/Offer workflow incomplete | Stages 2-3 — dedicated endpoints |

### High risks

| Risk | Mitigation |
|------|-----------|
| Race conditions in status transitions | Add optimistic locking or version checking |
| Two-write atomicity for sub-contribution linking | `ChildContributionIDs` is convenience cache; `child.ParentContributionID` is authoritative |
| `interests` field uses last-write-wins | Acceptable for now; if concurrent registration is a problem, move to separate trees |
| `Project.Title` JSON key mismatch (`title` vs `name`) | Decide before Stage 1; frontend developer must be consulted |

### Ambiguous requirements needing clarification

| Requirement | Issue |
|-------------|-------|
| Budget format | "$50,000" vs "50000" vs "N/A" — standardise |
| Duration estimate units | Free text? Parse and normalise? |
| Deadline enforcement | What happens when deadline passes? |
| Parent contribution deletion | Cascade or restrict with active children? |
| Quality rating semantics | What do 1-10 mean? |

---

## 22. Review Checklist

Use this checklist to verify the implementation covers all requirements from the design documentation.

### Data models
- [ ] All `Contribution` fields from TypeScript interface present in Go struct
- [ ] All `ImplementationPlan` fields including `signed_off` tracking
- [ ] All `Milestone` fields including dates, status, criteria
- [ ] `FileRef` and `InterestedContributor` types defined
- [ ] All status constants including `shared` and `offered`

### API endpoints
- [ ] All 10 new endpoints implemented and registered
- [ ] RBAC middleware applied to all mutating endpoints
- [ ] Error responses include structured detail (blocking children, unconfirmed IDs)
- [ ] SSE events broadcast for all state-changing operations

### Permission logic
- [ ] Community Admin has full access
- [ ] Only Steward/Admin can confirm and sign off
- [ ] Only Lead/Steward/Admin can share and offer
- [ ] Only assigned contributor can submit evidence
- [ ] Sub-contribution creation restricted to assigned contributor of parent

### Status machine
- [ ] All valid transitions defined in `contributionTransitions` map
- [ ] Sub-contribution transitions (no shared/offered path)
- [ ] Plan transitions (draft → active on sign-off)
- [ ] Invalid transitions rejected with clear errors

### Business logic
- [ ] Plan sign-off requires all contributions confirmed
- [ ] Parent submission blocked by unsigned children
- [ ] Sub-contribution auto-assigned to parent's contributor
- [ ] Atomic child linking (parent's `ChildContributionIDs` updated)
- [ ] `RegisterInterest` accepts `shared` status (not `confirmed`)

### Frontend components
- [ ] All 15 components from design reference translated to Vue/Quasar
- [ ] `ContributionDetailDialog` includes all 12 sections
- [ ] All form validation rules implemented
- [ ] All toast messages match specification
- [ ] All badge colour mappings correct
- [ ] Empty states for projects, milestones, contributions, sub-contributions
- [ ] Milestone signed-off visual inversion (primary bg)
- [ ] Quality rating stars in review form
- [ ] File upload for evidence, time reports, attachments

### Tests
- [ ] E2E: proposal creation and project setup
- [ ] E2E: implementation plan and confirmation
- [ ] E2E: share, offer, register, accept
- [ ] E2E: sub-contribution creation and approval
- [ ] E2E: completion, review, and sign-off
- [ ] E2E: permission boundary edge cases
- [ ] Backend unit tests for all service methods
- [ ] Backend handler tests for all new endpoints
- [ ] Any-sync adapter tests for interest and file operations
