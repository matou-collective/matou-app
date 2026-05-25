# Contributions System Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five contributions-system updates: project delete-with-cascade (typed confirmation), edit/delete for milestones+contributions+sub-contributions, contributor unassign, lead→steward project-completion signoff, and uniform input heights across contribution & proposal forms.

**Architecture:** Reuse existing patterns — Pinia stores, Quasar dialogs, Go service-layer methods called from RBAC-guarded HTTP handlers. Two new enum values (`MilestoneArchived`, `ProjectPendingCompletion`) and three new fields on Project. All "delete" actions are status-only (no row deletion); cascades are transactional best-effort using existing `SaveContribution`/`SaveProject` calls (errors logged per-entity, propagated to caller). Two new shared dialog components (`ConfirmDestroyDialog`, `ConfirmArchiveDialog`) keep the UX consistent.

**Tech Stack:** Go (backend, `chi`-style mux), Vue 3 + Quasar + Pinia (frontend), Vitest (frontend unit), Playwright (frontend E2E), Go testing (backend unit).

**Spec:** `docs/superpowers/specs/2026-04-28-contributions-updates-design.md`

---

## File Structure

### New files

| Path | Responsibility |
| --- | --- |
| `frontend/src/components/common/ConfirmDestroyDialog.vue` | Reusable typed-confirmation (`DESTROY`) dialog with cascade summary |
| `frontend/src/components/common/ConfirmArchiveDialog.vue` | Reusable basic confirm dialog for archive operations |
| `frontend/src/components/projects/ProjectCompletionSection.vue` | Section on project detail page showing submit/approve/reject controls + completion state |
| `frontend/src/components/projects/MilestoneFormDialog.vue` | Renamed from `AddMilestoneDialog.vue`, supports `mode: 'create' \| 'edit'` |

### Modified files

**Backend**
- `backend/internal/contributions/models.go` — add `MilestoneArchived`, `ProjectPendingCompletion`, Project fields
- `backend/internal/contributions/roles.go` — add 6 new `Action*` constants & permission mappings
- `backend/internal/contributions/service.go` — add `ArchiveProject`, `ArchiveMilestone`, `ArchiveContribution`, `UnassignContribution`, `UpdateMilestone`, `SubmitProjectCompletion`, `ApproveProjectCompletion`, `RejectProjectCompletion`
- `backend/internal/contributions/service_test.go` — tests for the above
- `backend/internal/api/projects.go` — wire `archive`, `submit-completion`, `approve-completion`, `reject-completion` routes
- `backend/internal/api/contributions_handler.go` — wire `archive`, `unassign` routes
- `backend/internal/api/milestones.go` (new sub-routes) — wire `archive`, `PUT` routes (or add to existing milestone handler — verify path during Task 14)

**Frontend**
- `frontend/src/types/projects.ts` — add `'pending_completion'`, `'archived'` to enums; add Project fields
- `frontend/src/lib/api/projects.ts` — add `archiveProject`, `submitCompletion`, `approveCompletion`, `rejectCompletion`
- `frontend/src/lib/api/contributions.ts` — add `archiveContribution`, `unassignContribution`
- `frontend/src/lib/api/implementationPlans.ts` — add `archiveMilestone`, `updateMilestone`
- `frontend/src/stores/projects.ts` — add corresponding actions
- `frontend/src/stores/contributions.ts` — add corresponding actions
- `frontend/src/composables/useProjectPermissions.ts` — add new permission computeds
- `frontend/src/components/projects/ProjectForm.vue` — add Danger Zone with Delete button
- `frontend/src/components/contributions/ContributionForm.vue` — wire edit mode (already has prop), add unassign button, change array inputs to `type="textarea" autogrow`
- `frontend/src/components/projects/CreateContributionDialog.vue` — verify edit-mode pass-through
- `frontend/src/pages/Projects/ProjectDetailPage.vue` — add ProjectCompletionSection, milestone+contribution+sub-contribution edit/delete icons, badge styling
- `frontend/src/pages/Contributions/ContributionDetailPage.vue` — add edit/delete entry points (if surfaces sub-contributions)

---

## Task 0: Branch & worktree confirmation

**Files:** none

- [ ] **Step 1: Confirm working state**

Run:
```bash
git status -uno
git branch --show-current
```
Expected: branch `feature/contributions`, clean working tree (the spec was already committed).

- [ ] **Step 2: Establish baseline test pass**

Run:
```bash
cd backend && make test 2>&1 | tail -20
```
Expected: all unit tests pass (or note any pre-existing failures so we don't blame them on this work).

```bash
cd ../frontend && npm run lint 2>&1 | tail -10
```
Expected: clean (or note pre-existing).

---

## Task 1: Backend enum and Project field additions

**Files:**
- Modify: `backend/internal/contributions/models.go`

- [ ] **Step 1: Add `MilestoneArchived` to MilestoneStatus**

In `backend/internal/contributions/models.go`, modify the `MilestoneStatus` const block (around line 308):

```go
const (
	MilestonePlanned    MilestoneStatus = "planned"
	MilestoneInProgress MilestoneStatus = "in_progress"
	MilestoneCompleted  MilestoneStatus = "completed"
	MilestoneDelayed    MilestoneStatus = "delayed"
	MilestoneArchived   MilestoneStatus = "archived"
)
```

- [ ] **Step 2: Add `ProjectPendingCompletion` to ProjectStatus**

Modify the `ProjectStatus` const block (around line 122):

```go
const (
	ProjectCreated           ProjectStatus = "created"
	ProjectActive            ProjectStatus = "active"
	ProjectPendingCompletion ProjectStatus = "pending_completion"
	ProjectCompleted         ProjectStatus = "completed"
	ProjectArchived          ProjectStatus = "archived"
)
```

- [ ] **Step 3: Add CompletedBy, CompletedAt, RejectionReason to Project struct**

Append fields to the `Project` struct (around line 147):

```go
type Project struct {
	ID                    string         `json:"id"`
	Title                 string         `json:"title"`
	Description           string         `json:"description"`
	Status                ProjectStatus  `json:"status"`
	Images                []ProjectImage `json:"images,omitempty"`
	ProposalIDs           []string       `json:"proposal_ids,omitempty"`
	ImplementationPlanIDs []string       `json:"implementation_plan_ids,omitempty"`
	ProjectStewardID      string         `json:"project_steward_id,omitempty"`
	ProjectLeadID         string         `json:"project_lead_id,omitempty"`
	CreatedBy             string         `json:"created_by"`
	CreatedAt             time.Time      `json:"created_at"`
	UpdatedAt             time.Time      `json:"updated_at"`
	CompletedBy           string         `json:"completed_by,omitempty"`
	CompletedAt           *time.Time     `json:"completed_at,omitempty"`
	RejectionReason       string         `json:"rejection_reason,omitempty"`
}
```

- [ ] **Step 4: Build to verify**

Run: `cd backend && go build ./...`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/contributions/models.go
git commit -m "feat(contributions): add archived milestone status and pending_completion project status"
```

---

## Task 2: Backend RBAC actions

**Files:**
- Modify: `backend/internal/contributions/roles.go`
- Modify: `backend/internal/contributions/roles_test.go`

- [ ] **Step 1: Add new Action constants**

In `roles.go`, add to the const block (around line 53):

```go
const (
	// ... existing constants ...

	// Archive & lifecycle actions
	ActionArchiveProject          Action = "archive_project"
	ActionArchiveMilestone        Action = "archive_milestone"
	ActionArchiveContribution     Action = "archive_contribution"
	ActionUnassignContribution    Action = "unassign_contribution"
	ActionEditMilestone           Action = "edit_milestone"

	// Project completion workflow
	ActionSubmitProjectCompletion  Action = "submit_project_completion"
	ActionApproveProjectCompletion Action = "approve_project_completion"
	ActionRejectProjectCompletion  Action = "reject_project_completion"
)
```

- [ ] **Step 2: Add permission mappings**

Define a steward-scope role list at the top of `actionPermissions`:

```go
var stewardScope = []Role{
	RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember,
}

var leadStewardScope = []Role{
	RoleProjectLead, RoleProjectSteward, RoleOperationsSteward, RoleFoundingMember,
}
```

Add to `actionPermissions` map (alongside existing entries, before the closing `}`):

```go
ActionArchiveProject:          leadStewardScope,
ActionArchiveMilestone:        leadStewardScope,
ActionArchiveContribution:     leadStewardScope,
ActionUnassignContribution:    leadStewardScope,
ActionEditMilestone:           leadStewardScope,
ActionSubmitProjectCompletion: {RoleProjectLead, RoleOperationsSteward, RoleFoundingMember},
ActionApproveProjectCompletion: stewardScope,
ActionRejectProjectCompletion:  stewardScope,
```

(Note: backend RBAC verifies the user has SOME role granting the action. Project-level checks for "is THIS user the lead/steward of THIS project" stay on the frontend, matching existing comment at `roles.go:85`.)

- [ ] **Step 3: Write failing test**

Append to `backend/internal/contributions/roles_test.go`:

```go
func TestActionArchiveProject_AllowedRoles(t *testing.T) {
	cases := []struct {
		role    Role
		allowed bool
	}{
		{RoleProjectLead, true},
		{RoleProjectSteward, true},
		{RoleFoundingMember, true},
		{RoleOperationsSteward, true},
		{RoleMember, false},
		{RoleContributor, false},
	}
	for _, c := range cases {
		got := CanPerformAction([]Role{c.role}, ActionArchiveProject)
		if got != c.allowed {
			t.Errorf("ActionArchiveProject for %s: got %v, want %v", c.role, got, c.allowed)
		}
	}
}

func TestActionSubmitProjectCompletion_LeadOnly(t *testing.T) {
	if !CanPerformAction([]Role{RoleProjectLead}, ActionSubmitProjectCompletion) {
		t.Error("project lead should be able to submit completion")
	}
	if CanPerformAction([]Role{RoleProjectSteward}, ActionSubmitProjectCompletion) {
		// Steward gets it via OperationsSteward role only — pure ProjectSteward should NOT.
		t.Error("pure project steward should not be able to submit completion")
	}
	if !CanPerformAction([]Role{RoleFoundingMember}, ActionSubmitProjectCompletion) {
		t.Error("founding member should be able to submit completion")
	}
}

func TestActionApproveProjectCompletion_StewardScope(t *testing.T) {
	if !CanPerformAction([]Role{RoleProjectSteward}, ActionApproveProjectCompletion) {
		t.Error("project steward should be able to approve completion")
	}
	if CanPerformAction([]Role{RoleProjectLead}, ActionApproveProjectCompletion) {
		t.Error("project lead should NOT be able to approve completion")
	}
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `cd backend && go test ./internal/contributions/ -run TestAction -v`
Expected: all three new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/contributions/roles.go backend/internal/contributions/roles_test.go
git commit -m "feat(contributions): add RBAC actions for archive, unassign, project completion"
```

---

## Task 3: Backend service — ArchiveProject

**Files:**
- Modify: `backend/internal/contributions/service.go`
- Modify: `backend/internal/contributions/service_test.go`

- [ ] **Step 1: Write failing test**

Add to `service_test.go`:

```go
func TestArchiveProject_CascadesAllChildren(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "test-space"

	// Set up: project + plan + milestone + contribution + sub-contribution
	proj, err := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "Test", Description: "d", CreatedBy: "u"})
	if err != nil { t.Fatal(err) }

	plan, err := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{
		ProjectID: proj.ID, ProjectLeadID: "u",
	})
	if err != nil { t.Fatal(err) }

	plan2, err := svc.AddMilestone(ctx, spaceID, plan.ID, &AddMilestoneRequest{Title: "M1", Duration: "1w"})
	if err != nil { t.Fatal(err) }
	msID := plan2.Milestones[0].MilestoneID

	contrib, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, MilestoneID: msID, Title: "C1", Description: "d",
		ContributionType: "development", CreatedBy: "u",
	})
	if err != nil { t.Fatal(err) }

	sub, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "Sub", Description: "d",
		ContributionType: "development", CreatedBy: "u",
		ParentContributionID: contrib.ID,
	})
	if err != nil { t.Fatal(err) }

	// Act
	if err := svc.ArchiveProject(ctx, spaceID, proj.ID); err != nil {
		t.Fatalf("ArchiveProject: %v", err)
	}

	// Assert all entities are archived
	gotProj, _ := svc.GetProject(ctx, spaceID, proj.ID)
	if gotProj.Status != ProjectArchived {
		t.Errorf("project status = %s, want archived", gotProj.Status)
	}
	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if gotPlan.Status != PlanArchived {
		t.Errorf("plan status = %s, want archived", gotPlan.Status)
	}
	for _, m := range gotPlan.Milestones {
		if m.Status != MilestoneArchived {
			t.Errorf("milestone %s status = %s, want archived", m.MilestoneID, m.Status)
		}
	}
	gotContrib, _ := svc.GetContribution(ctx, spaceID, contrib.ID)
	if gotContrib.Status != ContribArchived {
		t.Errorf("contribution status = %s, want archived", gotContrib.Status)
	}
	gotSub, _ := svc.GetContribution(ctx, spaceID, sub.ID)
	if gotSub.Status != ContribArchived {
		t.Errorf("sub-contribution status = %s, want archived", gotSub.Status)
	}
}
```

(If `CreateContributionRequest` doesn't already have `ParentContributionID`, check the existing field name in `models.go` / request types — adapt to the existing pattern.)

- [ ] **Step 2: Run test to confirm it fails**

Run: `cd backend && go test ./internal/contributions/ -run TestArchiveProject_CascadesAllChildren -v`
Expected: FAIL with `svc.ArchiveProject undefined` (compile error).

- [ ] **Step 3: Implement ArchiveProject in service.go**

Append to `service.go`:

```go
// ArchiveProject archives a project and all related entities.
// Cascade: project → plans → milestones → contributions → sub-contributions.
// Best-effort: per-entity SaveProject/SaveContribution failures are logged and
// the first error is returned, but the archival of remaining entities continues.
func (s *Service) ArchiveProject(ctx context.Context, spaceID, projectID string) error {
	proj, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil {
		return fmt.Errorf("get project: %w", err)
	}

	var firstErr error
	captureErr := func(e error) {
		if firstErr == nil && e != nil {
			firstErr = e
		}
	}

	// 1. Archive plans
	for _, planID := range proj.ImplementationPlanIDs {
		plan, err := s.GetImplementationPlan(ctx, spaceID, planID)
		if err != nil {
			captureErr(fmt.Errorf("get plan %s: %w", planID, err))
			continue
		}
		plan.Status = PlanArchived
		// Archive milestones inside the plan
		for i := range plan.Milestones {
			plan.Milestones[i].Status = MilestoneArchived
		}
		plan.UpdatedAt = time.Now()
		if err := s.SaveImplementationPlan(ctx, spaceID, plan); err != nil {
			captureErr(fmt.Errorf("save plan %s: %w", planID, err))
		}
	}

	// 2. Archive every contribution belonging to the project (covers sub-contributions too)
	contribs, err := s.ListContributionsByProject(ctx, spaceID, projectID)
	if err != nil {
		captureErr(fmt.Errorf("list contributions: %w", err))
	}
	for _, c := range contribs {
		c.Status = ContribArchived
		c.UpdatedAt = time.Now()
		if err := s.SaveContribution(ctx, spaceID, c); err != nil {
			captureErr(fmt.Errorf("save contribution %s: %w", c.ID, err))
		}
	}

	// 3. Archive the project
	proj.Status = ProjectArchived
	proj.UpdatedAt = time.Now()
	if err := s.SaveProject(ctx, spaceID, proj); err != nil {
		captureErr(fmt.Errorf("save project: %w", err))
	}

	return firstErr
}
```

If `SaveImplementationPlan` doesn't exist, mirror the existing `SaveProject`/`SaveContribution` pattern in `service.go` to add it (search for `SaveProject` to find the pattern).

- [ ] **Step 4: Run test — should pass**

Run: `cd backend && go test ./internal/contributions/ -run TestArchiveProject_CascadesAllChildren -v`
Expected: PASS.

- [ ] **Step 5: Run full backend test suite**

Run: `cd backend && go test ./...`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/contributions/service.go backend/internal/contributions/service_test.go
git commit -m "feat(contributions): add ArchiveProject service with cascade"
```

---

## Task 4: Backend service — ArchiveMilestone, ArchiveContribution, UnassignContribution, UpdateMilestone

**Files:**
- Modify: `backend/internal/contributions/service.go`
- Modify: `backend/internal/contributions/service_test.go`

- [ ] **Step 1: Write failing tests**

Append to `service_test.go`:

```go
func TestArchiveMilestone_CascadesContributions(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	plan, _ := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	planWithMs, _ := svc.AddMilestone(ctx, spaceID, plan.ID, &AddMilestoneRequest{Title: "M", Duration: "1w"})
	msID := planWithMs.Milestones[0].MilestoneID

	contrib, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, MilestoneID: msID, Title: "C", Description: "d",
		ContributionType: "development", CreatedBy: "u",
	})
	sub, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "Sub", Description: "d",
		ContributionType: "development", CreatedBy: "u",
		ParentContributionID: contrib.ID,
	})

	if err := svc.ArchiveMilestone(ctx, spaceID, msID); err != nil {
		t.Fatalf("ArchiveMilestone: %v", err)
	}

	gotPlan, _ := svc.GetImplementationPlan(ctx, spaceID, plan.ID)
	if gotPlan.Milestones[0].Status != MilestoneArchived {
		t.Errorf("milestone status = %s, want archived", gotPlan.Milestones[0].Status)
	}
	gotContrib, _ := svc.GetContribution(ctx, spaceID, contrib.ID)
	if gotContrib.Status != ContribArchived {
		t.Errorf("contribution status = %s, want archived", gotContrib.Status)
	}
	gotSub, _ := svc.GetContribution(ctx, spaceID, sub.ID)
	if gotSub.Status != ContribArchived {
		t.Errorf("sub status = %s, want archived", gotSub.Status)
	}
}

func TestArchiveContribution_CascadesSubContributions(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	parent, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "P", Description: "d", ContributionType: "development", CreatedBy: "u",
	})
	sub, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "S", Description: "d", ContributionType: "development", CreatedBy: "u",
		ParentContributionID: parent.ID,
	})

	if err := svc.ArchiveContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("ArchiveContribution: %v", err)
	}

	gotParent, _ := svc.GetContribution(ctx, spaceID, parent.ID)
	if gotParent.Status != ContribArchived {
		t.Errorf("parent status = %s, want archived", gotParent.Status)
	}
	gotSub, _ := svc.GetContribution(ctx, spaceID, sub.ID)
	if gotSub.Status != ContribArchived {
		t.Errorf("sub status = %s, want archived", gotSub.Status)
	}
}

func TestUnassignContribution_AllowedStatuses(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})

	// Set up an assigned contribution
	contrib, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
	})
	contrib.Status = ContribAssigned
	contrib.AssignedContributorID = "user-1"
	_ = svc.SaveContribution(ctx, spaceID, contrib)

	// Unassign should succeed for assigned status
	got, err := svc.UnassignContribution(ctx, spaceID, contrib.ID)
	if err != nil {
		t.Fatalf("UnassignContribution: %v", err)
	}
	if got.Status != ContribConfirmed {
		t.Errorf("status = %s, want confirmed", got.Status)
	}
	if got.AssignedContributorID != "" {
		t.Errorf("assigned_contributor_id = %q, want empty", got.AssignedContributorID)
	}
}

func TestUnassignContribution_RejectsTerminalStatuses(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	contrib, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
	})

	for _, badStatus := range []ContributionStatus{ContribSignedOff, ContribApproved, ContribNeedsReview, ContribCreated} {
		contrib.Status = badStatus
		contrib.AssignedContributorID = "user-1"
		_ = svc.SaveContribution(ctx, spaceID, contrib)

		_, err := svc.UnassignContribution(ctx, spaceID, contrib.ID)
		if err == nil {
			t.Errorf("UnassignContribution from %s should fail, got nil", badStatus)
		}
	}
}

func TestUpdateMilestone_PatchesFields(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	plan, _ := svc.CreateImplementationPlan(ctx, spaceID, &CreateImplementationPlanRequest{ProjectID: proj.ID, ProjectLeadID: "u"})
	pwm, _ := svc.AddMilestone(ctx, spaceID, plan.ID, &AddMilestoneRequest{Title: "Old", Duration: "1w"})
	msID := pwm.Milestones[0].MilestoneID

	got, err := svc.UpdateMilestone(ctx, spaceID, msID, &UpdateMilestoneRequest{
		Title:       strPtr("New title"),
		Description: strPtr("desc"),
		Duration:    strPtr("2w"),
	})
	if err != nil { t.Fatalf("UpdateMilestone: %v", err) }
	if got.Title != "New title" { t.Errorf("title = %q, want New title", got.Title) }
	if got.Description != "desc" { t.Errorf("description = %q, want desc", got.Description) }
	if got.Duration != "2w" { t.Errorf("duration = %q, want 2w", got.Duration) }
}

func strPtr(s string) *string { return &s }
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd backend && go test ./internal/contributions/ -run "TestArchiveMilestone|TestArchiveContribution|TestUnassign|TestUpdateMilestone" -v`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement service methods**

Append to `service.go`:

```go
// ArchiveMilestone archives a single milestone and cascades to its contributions
// (and any sub-contributions of those).
func (s *Service) ArchiveMilestone(ctx context.Context, spaceID, milestoneID string) error {
	plan, ms, err := s.findMilestone(ctx, spaceID, milestoneID)
	if err != nil { return err }

	var firstErr error
	capture := func(e error) { if firstErr == nil && e != nil { firstErr = e } }

	// Archive the milestone in its plan
	for i := range plan.Milestones {
		if plan.Milestones[i].MilestoneID == milestoneID {
			plan.Milestones[i].Status = MilestoneArchived
		}
	}
	plan.UpdatedAt = time.Now()
	if err := s.SaveImplementationPlan(ctx, spaceID, plan); err != nil {
		capture(fmt.Errorf("save plan: %w", err))
	}

	// Archive contributions whose MilestoneID matches (and their sub-contributions
	// — sub-contributions don't carry MilestoneID, so we walk by parent).
	contribs, err := s.ListContributionsByProject(ctx, spaceID, ms.ProjectID)
	if err != nil { return err }

	// Build parent -> []children map and archive sets recursively
	toArchive := map[string]bool{}
	byParent := map[string][]*Contribution{}
	for _, c := range contribs {
		byParent[c.ParentContributionID] = append(byParent[c.ParentContributionID], c)
	}
	var walk func(id string)
	walk = func(id string) {
		toArchive[id] = true
		for _, child := range byParent[id] {
			walk(child.ID)
		}
	}
	for _, c := range contribs {
		if c.MilestoneID == milestoneID {
			walk(c.ID)
		}
	}

	for _, c := range contribs {
		if toArchive[c.ID] {
			c.Status = ContribArchived
			c.UpdatedAt = time.Now()
			if err := s.SaveContribution(ctx, spaceID, c); err != nil {
				capture(fmt.Errorf("save contribution %s: %w", c.ID, err))
			}
		}
	}

	return firstErr
}

// findMilestone locates a milestone by id, returning its parent plan and the milestone.
func (s *Service) findMilestone(ctx context.Context, spaceID, milestoneID string) (*ImplementationPlan, *Milestone, error) {
	// Iterate all plans in space to find the one containing this milestone.
	// (Mirror existing patterns in service.go for plan lookup.)
	plans, err := s.ListImplementationPlans(ctx, spaceID)
	if err != nil { return nil, nil, err }
	for _, p := range plans {
		for i := range p.Milestones {
			if p.Milestones[i].MilestoneID == milestoneID {
				return p, &p.Milestones[i], nil
			}
		}
	}
	return nil, nil, fmt.Errorf("milestone %s not found", milestoneID)
}

// ArchiveContribution archives a single contribution and cascades to its sub-contributions.
func (s *Service) ArchiveContribution(ctx context.Context, spaceID, contribID string) error {
	contrib, err := s.GetContribution(ctx, spaceID, contribID)
	if err != nil { return err }

	// Walk children
	all, err := s.ListContributionsByProject(ctx, spaceID, contrib.ProjectID)
	if err != nil { return err }

	byParent := map[string][]*Contribution{}
	for _, c := range all {
		byParent[c.ParentContributionID] = append(byParent[c.ParentContributionID], c)
	}

	var firstErr error
	capture := func(e error) { if firstErr == nil && e != nil { firstErr = e } }

	var archive func(id string)
	archive = func(id string) {
		c, err := s.GetContribution(ctx, spaceID, id)
		if err != nil { capture(err); return }
		c.Status = ContribArchived
		c.UpdatedAt = time.Now()
		if err := s.SaveContribution(ctx, spaceID, c); err != nil {
			capture(err)
		}
		for _, child := range byParent[id] {
			archive(child.ID)
		}
	}
	archive(contribID)
	return firstErr
}

// UnassignContribution clears the assignee and reverts status to confirmed.
// Returns an error if the contribution is not in {assigned, in_progress}.
// (Note: the existing contribution status enum doesn't have an explicit "in_progress"
// — it goes assigned → needs_review. We allow unassign only at "assigned".)
func (s *Service) UnassignContribution(ctx context.Context, spaceID, contribID string) (*Contribution, error) {
	c, err := s.GetContribution(ctx, spaceID, contribID)
	if err != nil { return nil, err }

	switch c.Status {
	case ContribAssigned:
		// allowed
	default:
		return nil, fmt.Errorf("cannot unassign from status %q (must be assigned)", c.Status)
	}

	c.AssignedContributorID = ""
	c.AssignedContributorName = ""
	c.Status = ContribConfirmed
	c.UpdatedAt = time.Now()
	if err := s.SaveContribution(ctx, spaceID, c); err != nil {
		return nil, err
	}
	return c, nil
}

// UpdateMilestoneRequest captures patch-style milestone updates.
type UpdateMilestoneRequest struct {
	Title           *string  `json:"title,omitempty"`
	Description     *string  `json:"description,omitempty"`
	Duration        *string  `json:"duration,omitempty"`
	StartDate       *string  `json:"start_date,omitempty"`
	EndDate         *string  `json:"end_date,omitempty"`
	SuccessCriteria []string `json:"success_criteria,omitempty"`
	Status          *string  `json:"status,omitempty"`
}

// UpdateMilestone patches a milestone's fields.
func (s *Service) UpdateMilestone(ctx context.Context, spaceID, milestoneID string, req *UpdateMilestoneRequest) (*Milestone, error) {
	plan, _, err := s.findMilestone(ctx, spaceID, milestoneID)
	if err != nil { return nil, err }

	var updated *Milestone
	for i := range plan.Milestones {
		if plan.Milestones[i].MilestoneID != milestoneID { continue }
		m := &plan.Milestones[i]
		if req.Title != nil { m.Title = *req.Title }
		if req.Description != nil { m.Description = *req.Description }
		if req.Duration != nil { m.Duration = *req.Duration }
		if req.StartDate != nil { m.StartDate = *req.StartDate }
		if req.EndDate != nil { m.EndDate = *req.EndDate }
		if req.SuccessCriteria != nil { m.SuccessCriteria = req.SuccessCriteria }
		if req.Status != nil { m.Status = MilestoneStatus(*req.Status) }
		updated = m
		break
	}
	if updated == nil { return nil, fmt.Errorf("milestone %s not found", milestoneID) }
	plan.UpdatedAt = time.Now()
	if err := s.SaveImplementationPlan(ctx, spaceID, plan); err != nil {
		return nil, err
	}
	return updated, nil
}
```

NOTE: If `ListImplementationPlans` does not yet exist, find the plan by walking all projects' `ImplementationPlanIDs` instead — search service.go for the existing list/iterate pattern. Add this helper if needed:

```go
// ListImplementationPlans returns all plans in the space.
func (s *Service) ListImplementationPlans(ctx context.Context, spaceID string) ([]*ImplementationPlan, error) {
	// implementation: mirror ListProjects pattern, scanning the store
	// (replace this comment with the actual store call once you've located the pattern in store.go)
	return s.store.ListImplementationPlans(ctx, spaceID)
}
```

If `s.store.ListImplementationPlans` doesn't exist, add the corresponding method on `Store` interface and `MockStore` — search for `ListProjects` in `store.go` and `testutil.go` for the pattern.

- [ ] **Step 4: Run tests — should pass**

Run: `cd backend && go test ./internal/contributions/ -run "TestArchiveMilestone|TestArchiveContribution|TestUnassign|TestUpdateMilestone" -v`
Expected: PASS.

- [ ] **Step 5: Run full backend test suite**

Run: `cd backend && go test ./...`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/contributions/
git commit -m "feat(contributions): add ArchiveMilestone, ArchiveContribution, UnassignContribution, UpdateMilestone"
```

---

## Task 5: Backend service — Project completion workflow

**Files:**
- Modify: `backend/internal/contributions/service.go`
- Modify: `backend/internal/contributions/service_test.go`

- [ ] **Step 1: Write failing tests**

Append to `service_test.go`:

```go
func TestSubmitProjectCompletion_RequiresAllSignedOff(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	proj.Status = ProjectActive
	_ = svc.SaveProject(ctx, spaceID, proj)

	c1, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C1", Description: "d", ContributionType: "development", CreatedBy: "u",
	})

	// Not signed off — should fail
	if _, err := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "lead"); err == nil {
		t.Error("expected error when not all contributions signed off")
	}

	// Sign it off
	c1.Status = ContribSignedOff
	_ = svc.SaveContribution(ctx, spaceID, c1)

	got, err := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "lead")
	if err != nil { t.Fatalf("SubmitProjectCompletion: %v", err) }
	if got.Status != ProjectPendingCompletion {
		t.Errorf("status = %s, want pending_completion", got.Status)
	}
}

func TestSubmitProjectCompletion_RejectsNonActiveStatus(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	proj.Status = ProjectCompleted
	_ = svc.SaveProject(ctx, spaceID, proj)

	if _, err := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "lead"); err == nil {
		t.Error("expected error when project status is not active")
	}
}

func TestApproveProjectCompletion_FillsCompletedFields(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	proj.Status = ProjectPendingCompletion
	_ = svc.SaveProject(ctx, spaceID, proj)

	got, err := svc.ApproveProjectCompletion(ctx, spaceID, proj.ID, "steward-1")
	if err != nil { t.Fatalf("ApproveProjectCompletion: %v", err) }
	if got.Status != ProjectCompleted {
		t.Errorf("status = %s, want completed", got.Status)
	}
	if got.CompletedBy != "steward-1" {
		t.Errorf("completed_by = %q, want steward-1", got.CompletedBy)
	}
	if got.CompletedAt == nil {
		t.Error("completed_at should be set")
	}
}

func TestRejectProjectCompletion_RevertsToActive(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	proj.Status = ProjectPendingCompletion
	_ = svc.SaveProject(ctx, spaceID, proj)

	got, err := svc.RejectProjectCompletion(ctx, spaceID, proj.ID, "needs more work")
	if err != nil { t.Fatalf("RejectProjectCompletion: %v", err) }
	if got.Status != ProjectActive {
		t.Errorf("status = %s, want active", got.Status)
	}
	if got.RejectionReason != "needs more work" {
		t.Errorf("rejection_reason = %q, want needs more work", got.RejectionReason)
	}
}

func TestSubmitProjectCompletion_ClearsPriorRejection(t *testing.T) {
	ctx := context.Background()
	store := NewMockStore()
	svc := NewService(store)
	spaceID := "s"

	proj, _ := svc.CreateProject(ctx, spaceID, &CreateProjectRequest{Title: "P", Description: "d", CreatedBy: "u"})
	proj.Status = ProjectActive
	proj.RejectionReason = "previous reason"
	_ = svc.SaveProject(ctx, spaceID, proj)

	c1, _ := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: proj.ID, Title: "C", Description: "d", ContributionType: "development", CreatedBy: "u",
	})
	c1.Status = ContribSignedOff
	_ = svc.SaveContribution(ctx, spaceID, c1)

	got, _ := svc.SubmitProjectCompletion(ctx, spaceID, proj.ID, "lead")
	if got.RejectionReason != "" {
		t.Errorf("rejection_reason = %q, want empty", got.RejectionReason)
	}
}
```

- [ ] **Step 2: Run tests — should fail**

Run: `cd backend && go test ./internal/contributions/ -run "TestSubmitProjectCompletion|TestApproveProjectCompletion|TestRejectProjectCompletion" -v`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement service methods**

Append to `service.go`:

```go
// SubmitProjectCompletion transitions an active project to pending_completion
// after verifying every contribution is signed off.
// Clears any prior rejection_reason.
func (s *Service) SubmitProjectCompletion(ctx context.Context, spaceID, projectID, leadID string) (*Project, error) {
	proj, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil { return nil, err }

	if proj.Status != ProjectActive {
		return nil, fmt.Errorf("project must be active to submit completion (current: %s)", proj.Status)
	}

	contribs, err := s.ListContributionsByProject(ctx, spaceID, projectID)
	if err != nil { return nil, err }
	if len(contribs) == 0 {
		return nil, fmt.Errorf("project has no contributions")
	}
	for _, c := range contribs {
		if c.Status != ContribSignedOff && c.Status != ContribArchived {
			return nil, fmt.Errorf("contribution %s is %s, must be signed_off", c.ID, c.Status)
		}
	}

	proj.Status = ProjectPendingCompletion
	proj.RejectionReason = ""
	proj.UpdatedAt = time.Now()
	if err := s.SaveProject(ctx, spaceID, proj); err != nil {
		return nil, err
	}
	return proj, nil
}

// ApproveProjectCompletion marks the project completed.
func (s *Service) ApproveProjectCompletion(ctx context.Context, spaceID, projectID, stewardID string) (*Project, error) {
	proj, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil { return nil, err }
	if proj.Status != ProjectPendingCompletion {
		return nil, fmt.Errorf("project must be pending_completion (current: %s)", proj.Status)
	}
	now := time.Now()
	proj.Status = ProjectCompleted
	proj.CompletedBy = stewardID
	proj.CompletedAt = &now
	proj.UpdatedAt = now
	if err := s.SaveProject(ctx, spaceID, proj); err != nil {
		return nil, err
	}
	return proj, nil
}

// RejectProjectCompletion sends the project back to active with a reason.
func (s *Service) RejectProjectCompletion(ctx context.Context, spaceID, projectID, reason string) (*Project, error) {
	proj, err := s.GetProject(ctx, spaceID, projectID)
	if err != nil { return nil, err }
	if proj.Status != ProjectPendingCompletion {
		return nil, fmt.Errorf("project must be pending_completion (current: %s)", proj.Status)
	}
	proj.Status = ProjectActive
	proj.RejectionReason = reason
	proj.UpdatedAt = time.Now()
	if err := s.SaveProject(ctx, spaceID, proj); err != nil {
		return nil, err
	}
	return proj, nil
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `cd backend && go test ./internal/contributions/ -run "TestSubmit|TestApprove|TestReject" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/contributions/service.go backend/internal/contributions/service_test.go
git commit -m "feat(contributions): add project completion workflow services"
```

---

## Task 6: Backend HTTP — project archive & completion endpoints

**Files:**
- Modify: `backend/internal/api/projects.go`

- [ ] **Step 1: Add four sub-route handlers in RegisterRoutes**

In `projects.go`, inside the `mux.HandleFunc("/api/v1/projects/", ...)` block, extend the `len(parts) == 2` switch (around line 60) with four new cases:

```go
case "archive":
	if r.Method == http.MethodPost {
		if roleLookup != nil {
			RBACMiddleware(roleLookup, RequireAction(contributions.ActionArchiveProject, func(w http.ResponseWriter, r *http.Request) {
				h.HandleArchive(w, r, id)
			}))(w, r)
		} else {
			h.HandleArchive(w, r, id)
		}
		return
	}
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	return
case "submit-completion":
	if r.Method == http.MethodPost {
		if roleLookup != nil {
			RBACMiddleware(roleLookup, RequireAction(contributions.ActionSubmitProjectCompletion, func(w http.ResponseWriter, r *http.Request) {
				h.HandleSubmitCompletion(w, r, id)
			}))(w, r)
		} else {
			h.HandleSubmitCompletion(w, r, id)
		}
		return
	}
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	return
case "approve-completion":
	if r.Method == http.MethodPost {
		if roleLookup != nil {
			RBACMiddleware(roleLookup, RequireAction(contributions.ActionApproveProjectCompletion, func(w http.ResponseWriter, r *http.Request) {
				h.HandleApproveCompletion(w, r, id)
			}))(w, r)
		} else {
			h.HandleApproveCompletion(w, r, id)
		}
		return
	}
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	return
case "reject-completion":
	if r.Method == http.MethodPost {
		if roleLookup != nil {
			RBACMiddleware(roleLookup, RequireAction(contributions.ActionRejectProjectCompletion, func(w http.ResponseWriter, r *http.Request) {
				h.HandleRejectCompletion(w, r, id)
			}))(w, r)
		} else {
			h.HandleRejectCompletion(w, r, id)
		}
		return
	}
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	return
```

- [ ] **Step 2: Implement four handlers**

Append to `projects.go`:

```go
// HandleArchive handles POST /api/v1/projects/{id}/archive
func (h *ProjectsHandler) HandleArchive(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	if err := h.service.ArchiveProject(r.Context(), spaceID, id); err != nil {
		log.Printf("[Projects] archive failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Projects] project archived: %s", id)
	writeJSON(w, http.StatusOK, map[string]string{"success": "true"})
}

// HandleSubmitCompletion handles POST /api/v1/projects/{id}/submit-completion
func (h *ProjectsHandler) HandleSubmitCompletion(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	leadID := GetUserAID(r)
	proj, err := h.service.SubmitProjectCompletion(r.Context(), spaceID, id, leadID)
	if err != nil {
		log.Printf("[Projects] submit-completion failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Projects] project %s submitted for completion", id)
	writeJSON(w, http.StatusOK, proj)
}

// HandleApproveCompletion handles POST /api/v1/projects/{id}/approve-completion
func (h *ProjectsHandler) HandleApproveCompletion(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	stewardID := GetUserAID(r)
	if stewardID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "X-User-AID header required"})
		return
	}
	proj, err := h.service.ApproveProjectCompletion(r.Context(), spaceID, id, stewardID)
	if err != nil {
		log.Printf("[Projects] approve-completion failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Projects] project %s completion approved by %s", id, stewardID)
	writeJSON(w, http.StatusOK, proj)
}

// HandleRejectCompletion handles POST /api/v1/projects/{id}/reject-completion
func (h *ProjectsHandler) HandleRejectCompletion(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	proj, err := h.service.RejectProjectCompletion(r.Context(), spaceID, id, req.Reason)
	if err != nil {
		log.Printf("[Projects] reject-completion failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Projects] project %s completion rejected", id)
	writeJSON(w, http.StatusOK, proj)
}
```

- [ ] **Step 3: Build & test**

Run: `cd backend && go build ./... && go test ./internal/api/`
Expected: clean build, no regressions.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/api/projects.go
git commit -m "feat(api): wire project archive and completion endpoints"
```

---

## Task 7: Backend HTTP — contribution archive & unassign endpoints

**Files:**
- Modify: `backend/internal/api/contributions_handler.go`

- [ ] **Step 1: Add two sub-route cases**

In the `len(parts) == 2` switch in `RegisterRoutes` (around line 82), add:

```go
case "archive":
	if r.Method == http.MethodPost {
		h.withRBAC(contributions.ActionArchiveContribution, h.HandleArchive)(w, r)
		return
	}
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	return
case "unassign":
	if r.Method == http.MethodPost {
		h.withRBAC(contributions.ActionUnassignContribution, h.HandleUnassign)(w, r)
		return
	}
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	return
```

- [ ] **Step 2: Implement handlers**

Append to `contributions_handler.go`:

```go
// HandleArchive handles POST /api/v1/contributions/{id}/archive
func (h *ContributionsHandler) HandleArchive(w http.ResponseWriter, r *http.Request) {
	id := extractContribID(r, "/api/v1/contributions/", "/archive")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	if err := h.service.ArchiveContribution(r.Context(), spaceID, id); err != nil {
		log.Printf("[Contributions] archive failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution %s archived", id)
	if h.broker != nil {
		h.broker.Broadcast(SSEEvent{
			Type: "contribution:archived",
			Data: map[string]string{"contribution_id": id},
		})
	}
	writeJSON(w, http.StatusOK, map[string]string{"success": "true"})
}

// HandleUnassign handles POST /api/v1/contributions/{id}/unassign
func (h *ContributionsHandler) HandleUnassign(w http.ResponseWriter, r *http.Request) {
	id := extractContribID(r, "/api/v1/contributions/", "/unassign")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "contribution id required"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	contrib, err := h.service.UnassignContribution(r.Context(), spaceID, id)
	if err != nil {
		log.Printf("[Contributions] unassign failed for %s: %v", id, err)
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("[Contributions] contribution %s unassigned", id)
	if h.broker != nil {
		h.broker.Broadcast(SSEEvent{
			Type: "contribution:unassigned",
			Data: map[string]string{"contribution_id": id},
		})
	}
	writeJSON(w, http.StatusOK, contrib)
}
```

- [ ] **Step 3: Build**

Run: `cd backend && go build ./...`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/api/contributions_handler.go
git commit -m "feat(api): wire contribution archive and unassign endpoints"
```

---

## Task 8: Backend HTTP — milestone archive & update endpoints

**Files:**
- Modify: `backend/internal/api/` (find existing milestones handler — likely `implementation_plans.go` or `milestones.go`; if none, add to projects.go or create new)

- [ ] **Step 1: Locate the milestone handler**

Run:
```bash
grep -rn "milestones\|/milestone" backend/internal/api/ | grep -v _test
```

If a milestones handler already exists, modify it. If not, the milestones live under implementation plans — add new sub-routes to that handler, OR create `backend/internal/api/milestones.go` with its own `RegisterRoutes`.

- [ ] **Step 2: Add two new endpoints**

Pattern (adapt to where you placed the handler):

```go
// HandleArchiveMilestone handles POST /api/v1/milestones/{id}/archive
func (h *MilestonesHandler) HandleArchiveMilestone(w http.ResponseWriter, r *http.Request, id string) {
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	if err := h.service.ArchiveMilestone(r.Context(), spaceID, id); err != nil {
		log.Printf("[Milestones] archive failed for %s: %v", id, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"success": "true"})
}

// HandleUpdateMilestone handles PUT /api/v1/milestones/{id}
func (h *MilestonesHandler) HandleUpdateMilestone(w http.ResponseWriter, r *http.Request, id string) {
	var req contributions.UpdateMilestoneRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	spaceID := resolveCommunitySpaceID(r, h.spaceManager)
	ms, err := h.service.UpdateMilestone(r.Context(), spaceID, id, &req)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, ms)
}
```

Wire them with RBAC `ActionEditMilestone` (PUT) and `ActionArchiveMilestone` (archive), following the same `roleLookup` pattern as projects.go.

If creating a new file, register the new handler in `backend/cmd/server/main.go` (search for `RegisterRoutes` calls to find where).

- [ ] **Step 3: Build & test**

Run: `cd backend && go build ./... && go test ./internal/api/`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add backend/
git commit -m "feat(api): wire milestone update and archive endpoints"
```

---

## Task 9: Frontend types — enum & Project field updates

**Files:**
- Modify: `frontend/src/types/projects.ts`
- Modify: `frontend/src/lib/api/projects.ts`

- [ ] **Step 1: Add enum values in types/projects.ts**

In `frontend/src/types/projects.ts`:

Replace line 6 `export type ProjectStatus = 'created' | 'active' | 'completed' | 'archived';` with:

```typescript
export type ProjectStatus = 'created' | 'active' | 'pending_completion' | 'completed' | 'archived';
```

Replace line 31 `export type MilestoneStatus = 'planned' | 'in_progress' | 'completed' | 'delayed';` with:

```typescript
export type MilestoneStatus = 'planned' | 'in_progress' | 'completed' | 'delayed' | 'archived';
```

Add three fields to the `Project` interface (around line 175):

```typescript
export interface Project {
  // ... existing ...
  completed_by?: string;
  completed_at?: string;
  rejection_reason?: string;
}
```

- [ ] **Step 2: Mirror in api/projects.ts**

In `frontend/src/lib/api/projects.ts`, update `Project` interface (line 19):

```typescript
export interface Project {
  id: string;
  title: string;
  description: string;
  status: 'created' | 'active' | 'pending_completion' | 'completed' | 'archived';
  // ... existing fields ...
  completed_by?: string;
  completed_at?: string;
  rejection_reason?: string;
}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | head -40`
Expected: no new errors related to these types.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/projects.ts frontend/src/lib/api/projects.ts
git commit -m "feat(frontend): add pending_completion + archived enums and Project completion fields"
```

---

## Task 10: Frontend API client additions

**Files:**
- Modify: `frontend/src/lib/api/projects.ts`
- Modify: `frontend/src/lib/api/contributions.ts`
- Modify: `frontend/src/lib/api/implementationPlans.ts`

- [ ] **Step 1: Add archive + completion functions to projects.ts**

Append to `frontend/src/lib/api/projects.ts`:

```typescript
export async function archiveProject(id: string): Promise<void> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${id}/archive`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to archive project');
  }
}

export async function submitProjectCompletion(id: string): Promise<Project> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${id}/submit-completion`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to submit project completion');
  }
  return response.json();
}

export async function approveProjectCompletion(id: string): Promise<Project> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${id}/approve-completion`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to approve project completion');
  }
  return response.json();
}

export async function rejectProjectCompletion(id: string, reason: string): Promise<Project> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${id}/reject-completion`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to reject project completion');
  }
  return response.json();
}
```

- [ ] **Step 2: Add archive + unassign to contributions.ts**

Append to `frontend/src/lib/api/contributions.ts`:

```typescript
export async function archiveContribution(id: string): Promise<void> {
  log.info('Archiving contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/archive`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to archive contribution');
  }
}

export async function unassignContribution(id: string): Promise<Contribution> {
  log.info('Unassigning contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/unassign`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to unassign contribution');
  }
  return response.json();
}
```

- [ ] **Step 3: Add archive + update to implementationPlans.ts**

Read the existing file first to see the patterns:

```bash
grep -n "export interface\|export async" frontend/src/lib/api/implementationPlans.ts
```

Append (adapt types to match the existing `Milestone` import in that file):

```typescript
export interface UpdateMilestoneRequest {
  title?: string;
  description?: string;
  duration?: string;
  start_date?: string;
  end_date?: string;
  success_criteria?: string[];
  status?: string;
}

export async function updateMilestone(id: string, req: UpdateMilestoneRequest): Promise<Milestone> {
  const response = await fetch(`${BACKEND_URL}/api/v1/milestones/${id}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to update milestone');
  }
  return response.json();
}

export async function archiveMilestone(id: string): Promise<void> {
  const response = await fetch(`${BACKEND_URL}/api/v1/milestones/${id}/archive`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to archive milestone');
  }
}
```

- [ ] **Step 4: Type-check**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | head -30`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api/
git commit -m "feat(frontend): add API clients for archive, unassign, and project completion"
```

---

## Task 11: Frontend store actions

**Files:**
- Modify: `frontend/src/stores/projects.ts`
- Modify: `frontend/src/stores/contributions.ts`

- [ ] **Step 1: Add actions to projects store**

In `frontend/src/stores/projects.ts`:

Add imports (line 7-8, alongside existing API imports):

```typescript
import {
  // ... existing imports ...
  archiveProject as apiArchive,
  submitProjectCompletion as apiSubmitCompletion,
  approveProjectCompletion as apiApproveCompletion,
  rejectProjectCompletion as apiRejectCompletion,
} from 'src/lib/api/projects';
import {
  // ... existing imports ...
  archiveMilestone as apiArchiveMilestone,
  updateMilestone as apiUpdateMilestone,
  type UpdateMilestoneRequest,
} from 'src/lib/api/implementationPlans';
```

Add actions (alongside existing `remove` action):

```typescript
async function archive(id: string) {
  error.value = null;
  try {
    await apiArchive(id);
    // Reflect archived status locally without removing — UI filters by status
    const idx = projects.value.findIndex(p => p.id === id);
    if (idx >= 0) projects.value[idx] = { ...projects.value[idx], status: 'archived' };
    if (currentProject.value?.id === id) {
      currentProject.value = { ...currentProject.value, status: 'archived' };
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Archive failed';
    throw e;
  }
}

function _patchProject(updated: Project) {
  const idx = projects.value.findIndex(p => p.id === updated.id);
  if (idx >= 0) projects.value[idx] = updated;
  if (currentProject.value?.id === updated.id) currentProject.value = updated;
}

async function submitCompletion(id: string) {
  error.value = null;
  try {
    const updated = await apiSubmitCompletion(id);
    _patchProject(updated);
    return updated;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Submit completion failed';
    throw e;
  }
}

async function approveCompletion(id: string) {
  error.value = null;
  try {
    const updated = await apiApproveCompletion(id);
    _patchProject(updated);
    return updated;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Approve completion failed';
    throw e;
  }
}

async function rejectCompletion(id: string, reason: string) {
  error.value = null;
  try {
    const updated = await apiRejectCompletion(id, reason);
    _patchProject(updated);
    return updated;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Reject completion failed';
    throw e;
  }
}

async function archiveMilestoneAction(planId: string, projectId: string, milestoneId: string) {
  error.value = null;
  try {
    await apiArchiveMilestone(milestoneId);
    // Re-fetch the plan to get fresh milestone statuses
    await fetchImplementationPlan(projectId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Archive milestone failed';
    throw e;
  }
}

async function updateMilestoneAction(projectId: string, milestoneId: string, req: UpdateMilestoneRequest) {
  error.value = null;
  try {
    await apiUpdateMilestone(milestoneId, req);
    await fetchImplementationPlan(projectId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Update milestone failed';
    throw e;
  }
}
```

Append the new actions to the returned object at the bottom of the store:

```typescript
return {
  // ... existing returns ...
  archive,
  submitCompletion,
  approveCompletion,
  rejectCompletion,
  archiveMilestone: archiveMilestoneAction,
  updateMilestone: updateMilestoneAction,
};
```

- [ ] **Step 2: Add actions to contributions store**

In `frontend/src/stores/contributions.ts`, add to the imports at line 4:

```typescript
import {
  // ... existing imports ...
  archiveContribution as apiArchiveContrib,
  unassignContribution as apiUnassign,
} from 'src/lib/api/contributions';
```

Add actions (alongside existing actions):

```typescript
async function archive(id: string) {
  error.value = null;
  try {
    await apiArchiveContrib(id);
    const idx = contributions.value.findIndex(c => c.id === id);
    if (idx >= 0) contributions.value[idx] = { ...contributions.value[idx], status: 'archived' };
    if (currentContribution.value?.id === id) {
      currentContribution.value = { ...currentContribution.value, status: 'archived' };
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Archive failed';
    throw e;
  }
}

async function unassign(id: string) {
  error.value = null;
  try {
    const updated = await apiUnassign(id);
    _patch(updated);
    return updated;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unassign failed';
    throw e;
  }
}
```

Append to the returned object:

```typescript
return {
  // ... existing ...
  archive,
  unassign,
};
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | head -30`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/stores/
git commit -m "feat(frontend): add store actions for archive, unassign, and project completion"
```

---

## Task 12: Frontend permission helper additions

**Files:**
- Modify: `frontend/src/composables/useProjectPermissions.ts`

- [ ] **Step 1: Add new permission computeds**

In `useProjectPermissions.ts`, add inside the function (after existing `canConfirmContribution`):

```typescript
const canArchiveProject = computed(() => isAdmin.value || isLead.value || isSteward.value);
const canArchiveMilestone = computed(() => isAdmin.value || isLead.value || isSteward.value);
const canArchiveContribution = computed(() => isAdmin.value || isLead.value || isSteward.value);
const canUnassignContributor = computed(() => isAdmin.value || isLead.value || isSteward.value);
const canEditMilestone = computed(() => isAdmin.value || isLead.value || isSteward.value);
const canSubmitProjectCompletion = computed(() => isAdmin.value || isLead.value);
const canApproveProjectCompletion = computed(() => isAdmin.value || isSteward.value);
const canRejectProjectCompletion = computed(() => isAdmin.value || isSteward.value);
```

Add them to the return object:

```typescript
return {
  // ... existing ...
  canArchiveProject,
  canArchiveMilestone,
  canArchiveContribution,
  canUnassignContributor,
  canEditMilestone,
  canSubmitProjectCompletion,
  canApproveProjectCompletion,
  canRejectProjectCompletion,
};
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | head -20`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/composables/useProjectPermissions.ts
git commit -m "feat(frontend): add permission helpers for archive, unassign, completion"
```

---

## Task 13: ConfirmDestroyDialog.vue (typed-confirmation)

**Files:**
- Create: `frontend/src/components/common/ConfirmDestroyDialog.vue`

- [ ] **Step 1: Create the component**

```vue
<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card class="destroy-dialog">
      <q-card-section class="row items-center q-pb-none">
        <q-icon name="warning" color="negative" size="28px" />
        <div class="text-h6 q-ml-sm">{{ title }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup @click="reset" />
      </q-card-section>

      <q-card-section>
        <p class="q-mb-sm">
          You are about to permanently archive
          <strong>{{ entityLabel }}</strong>. This will also archive:
        </p>
        <ul class="cascade-list">
          <li v-for="(item, i) in cascadeSummary" :key="i">{{ item }}</li>
        </ul>
        <p class="text-warning q-mt-md">
          This cannot be undone from the UI. To confirm, type
          <strong class="confirm-word">{{ confirmWord }}</strong> below.
        </p>

        <q-input
          v-model="typed"
          :label="`Type ${confirmWord} to confirm`"
          outlined
          dense
          autofocus
          @keyup.enter="onConfirm"
        />
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat label="Cancel" v-close-popup @click="reset" />
        <q-btn
          color="negative"
          unelevated
          :label="title"
          :disable="!matches"
          :loading="loading"
          @click="onConfirm"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';

interface Props {
  modelValue: boolean;
  title: string;
  entityLabel: string;
  cascadeSummary: string[];
  confirmWord?: string;
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  confirmWord: 'DESTROY',
  loading: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [];
}>();

const typed = ref('');
const matches = computed(() => typed.value === props.confirmWord);

function reset() {
  typed.value = '';
}

function onConfirm() {
  if (!matches.value) return;
  emit('confirm');
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) reset();
  },
);
</script>

<style scoped lang="scss">
.destroy-dialog {
  min-width: 480px;
  max-width: 560px;
}
.cascade-list {
  margin: 8px 0 0 0;
  padding-left: 20px;
  color: var(--matou-foreground);
}
.cascade-list li {
  padding: 2px 0;
  font-size: 0.9rem;
}
.confirm-word {
  letter-spacing: 1px;
  color: var(--matou-destructive);
  font-family: monospace;
}
.text-warning {
  color: var(--matou-destructive);
  font-size: 0.9rem;
}
</style>
```

- [ ] **Step 2: Write a Vitest unit test**

Create `frontend/src/components/common/__tests__/ConfirmDestroyDialog.test.ts` (mirror existing component test structure — find one with `find frontend/src -name "*.test.ts" | head -3`):

```typescript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { Quasar } from 'quasar';
import ConfirmDestroyDialog from '../ConfirmDestroyDialog.vue';

describe('ConfirmDestroyDialog', () => {
  it('disables confirm button until DESTROY is typed', async () => {
    const wrapper = mount(ConfirmDestroyDialog, {
      props: {
        modelValue: true,
        title: 'Delete Project',
        entityLabel: 'My Project',
        cascadeSummary: ['1 plan', '2 milestones'],
      },
      global: { plugins: [Quasar] },
    });

    const confirmBtn = wrapper.findAll('button').find(b => b.text().includes('Delete Project'));
    expect(confirmBtn?.attributes('disabled')).toBeDefined();

    const input = wrapper.find('input');
    await input.setValue('DESTROY');
    await wrapper.vm.$nextTick();

    const enabledBtn = wrapper.findAll('button').find(b => b.text().includes('Delete Project'));
    expect(enabledBtn?.attributes('disabled')).toBeUndefined();
  });

  it('emits confirm only when text matches', async () => {
    const wrapper = mount(ConfirmDestroyDialog, {
      props: {
        modelValue: true,
        title: 'Delete',
        entityLabel: 'X',
        cascadeSummary: [],
      },
      global: { plugins: [Quasar] },
    });
    const input = wrapper.find('input');
    await input.setValue('wrong');
    await input.trigger('keyup.enter');
    expect(wrapper.emitted('confirm')).toBeUndefined();

    await input.setValue('DESTROY');
    await input.trigger('keyup.enter');
    expect(wrapper.emitted('confirm')).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test**

Run: `cd frontend && npx vitest run src/components/common/__tests__/ConfirmDestroyDialog.test.ts`
Expected: PASS. (If existing project doesn't use vitest for components, skip this test step and mark covered by E2E in Task 22.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/common/
git commit -m "feat(frontend): add ConfirmDestroyDialog with typed confirmation"
```

---

## Task 14: ConfirmArchiveDialog.vue (basic confirm)

**Files:**
- Create: `frontend/src/components/common/ConfirmArchiveDialog.vue`

- [ ] **Step 1: Create the component**

```vue
<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card class="archive-dialog">
      <q-card-section class="row items-center q-pb-none">
        <q-icon name="archive" color="warning" size="24px" />
        <div class="text-h6 q-ml-sm">{{ title }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section>
        <p>{{ message }}</p>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat label="Cancel" v-close-popup />
        <q-btn
          color="negative"
          unelevated
          label="Archive"
          :loading="loading"
          @click="$emit('confirm')"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
interface Props {
  modelValue: boolean;
  title: string;
  message: string;
  loading?: boolean;
}

withDefaults(defineProps<Props>(), { loading: false });

defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [];
}>();
</script>

<style scoped lang="scss">
.archive-dialog {
  min-width: 380px;
  max-width: 480px;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/common/ConfirmArchiveDialog.vue
git commit -m "feat(frontend): add ConfirmArchiveDialog for basic archive confirmations"
```

---

## Task 15: ProjectForm.vue — Delete Project section

**Files:**
- Modify: `frontend/src/components/projects/ProjectForm.vue`
- Modify: `frontend/src/pages/Projects/ProjectDetailPage.vue` (or wherever ProjectForm is mounted)

- [ ] **Step 1: Add Danger Zone to ProjectForm.vue**

In `frontend/src/components/projects/ProjectForm.vue`, between the `Linked Proposals` `<div>` block and the closing `</q-card-section>` (around line 70), add:

```vue
        <!-- Danger Zone (edit mode only) -->
        <div v-if="isEdit && canDelete" class="danger-zone q-mt-md">
          <div class="text-subtitle2 danger-title q-mb-sm">Danger Zone</div>
          <q-btn
            no-caps
            outline
            color="negative"
            icon="delete_forever"
            label="Delete Project"
            @click="$emit('delete')"
          />
        </div>
```

In the script section, extend `Props`:

```typescript
interface Props {
  modelValue: boolean;
  project?: Project | null;
  isSubmitting?: boolean;
  submitError?: string | null;
  availableProposals?: Proposal[];
  linking?: boolean;
  canDelete?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  // ... existing defaults ...
  canDelete: false,
});
```

Extend emits:

```typescript
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'submit', data: { title: string; description: string }): void;
  (e: 'link-proposal', proposalId: string): void;
  (e: 'delete'): void;
}>();
```

Add styles:

```scss
.danger-zone {
  border-top: 1px solid var(--matou-border);
  padding-top: 16px;
  margin-top: 16px;
}
.danger-title {
  color: var(--matou-destructive);
  font-weight: 600;
}
```

- [ ] **Step 2: Wire delete handler in the parent page**

Find where `<ProjectForm>` is used:

```bash
grep -rn "ProjectForm" frontend/src --include="*.vue" | grep -v ProjectForm.vue
```

In each call site (likely `ProjectDetailPage.vue`), pass `:can-delete="canArchiveProject"` and handle `@delete`:

```vue
<ProjectForm
  v-model="showEdit"
  :project="project"
  :can-delete="canArchiveProject"
  @submit="handleSave"
  @delete="onDeleteRequested"
/>

<ConfirmDestroyDialog
  v-model="showDestroy"
  title="Delete Project"
  :entity-label="project?.title ?? ''"
  :cascade-summary="cascadeSummary"
  :loading="archiving"
  @confirm="confirmDestroy"
/>
```

In script (use `useProjectPermissions`, `useProjectsStore`):

```typescript
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectsStore } from 'src/stores/projects';
import { useContributionsStore } from 'src/stores/contributions';
import { useProjectPermissions } from 'src/composables/useProjectPermissions';
import ConfirmDestroyDialog from 'src/components/common/ConfirmDestroyDialog.vue';

const router = useRouter();
const projectsStore = useProjectsStore();
const contributionsStore = useContributionsStore();
const { canArchiveProject } = useProjectPermissions(/* refs to project + currentUser */);

const showEdit = ref(false);
const showDestroy = ref(false);
const archiving = ref(false);

const cascadeSummary = computed(() => {
  const plans = projectsStore.implementationPlans[project.value?.id ?? ''] ?? null;
  const contribs = projectsStore.projectContributions[project.value?.id ?? ''] ?? [];
  const milestoneCount = plans?.milestones?.length ?? 0;
  const subCount = contribs.filter(c => c.parent_contribution).length;
  const topCount = contribs.length - subCount;
  return [
    plans ? '1 implementation plan' : '0 implementation plans',
    `${milestoneCount} milestone${milestoneCount === 1 ? '' : 's'}`,
    `${topCount} contribution${topCount === 1 ? '' : 's'}`,
    `${subCount} sub-contribution${subCount === 1 ? '' : 's'}`,
  ];
});

function onDeleteRequested() {
  showEdit.value = false;
  showDestroy.value = true;
}

async function confirmDestroy() {
  if (!project.value) return;
  archiving.value = true;
  try {
    await projectsStore.archive(project.value.id);
    showDestroy.value = false;
    router.push('/projects');
  } finally {
    archiving.value = false;
  }
}
```

If the `useProjectPermissions` invocation in this file already exists, just add `canArchiveProject` to the destructure.

- [ ] **Step 3: Manual smoke test**

Run the dev servers (`make run` for backend, `npm run dev` for frontend), open a project as admin/lead, click Edit → Delete Project → see dialog → type DESTROY → confirm → verify project disappears from list and is `status='archived'` in backend.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/projects/ProjectForm.vue frontend/src/pages/Projects/ProjectDetailPage.vue
git commit -m "feat(frontend): add Delete Project flow with DESTROY typed confirmation"
```

---

## Task 16: ContributionForm.vue — edit mode + unassign + height fix (item 5)

**Files:**
- Modify: `frontend/src/components/contributions/ContributionForm.vue`

- [ ] **Step 1: Replace array input fields with textarea autogrow**

In `frontend/src/components/contributions/ContributionForm.vue`, change FOUR sections (Objectives at line 69, Deliverables at line 107, Acceptance Criteria at line 143, Skill Requirements at line 181). For each, replace the `q-input` element:

OLD:
```vue
<q-input
  v-model="form.objectives[i]"
  :label="`Objective ${i + 1}`"
  outlined
  dense
/>
```

NEW (apply pattern to all four — Objectives, Deliverables, Acceptance Criteria, Skill Requirements):
```vue
<q-input
  v-model="form.objectives[i]"
  :label="`Objective ${i + 1}`"
  outlined
  type="textarea"
  autogrow
/>
```

(Leave Skill Requirements as `dense` single-line if you prefer — but the user's complaint is about Objectives/Deliverables/Acceptance Criteria specifically. To match Proposals (which use textarea autogrow for these three), apply the textarea pattern to those three at minimum. Skill Requirements may stay dense for visual rhythm. Choose the pattern that matches CreateProposalDialog.vue exactly.)

Verify against `frontend/src/components/proposals/CreateProposalDialog.vue` first:

```bash
grep -A 3 "Objective\|Deliverable\|Acceptance" frontend/src/components/proposals/CreateProposalDialog.vue
```

Apply whatever attributes the proposal form uses (textarea + autogrow + outlined) to the three matching contribution fields. Skill Requirements: leave alone unless proposals also use textarea for its analog.

- [ ] **Step 2: Add Unassign button**

Inside `<q-card-section>` (after the Estimated Hours/Budget row, around line 222), add:

```vue
        <!-- Unassign (edit mode + has assignee + status allowed + permission) -->
        <div
          v-if="canShowUnassign"
          class="unassign-block q-mt-sm"
        >
          <q-banner class="bg-yellow-1 q-mb-sm">
            <template #avatar>
              <q-icon name="person" color="warning" />
            </template>
            Currently assigned to <strong>{{ contribution?.assigned_contributor_name || contribution?.assigned_contributor_id }}</strong>
          </q-banner>
          <q-btn
            outline
            no-caps
            color="negative"
            icon="person_remove"
            label="Unassign Contributor"
            @click="$emit('unassign')"
          />
        </div>
```

Extend Props and add a computed:

```typescript
const props = defineProps<{
  modelValue: boolean;
  contribution?: Contribution | null;
  defaultProjectId?: string;
  canUnassign?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  submit: [form: CreateContributionRequest | UpdateContributionRequest];
  unassign: [];
}>();

import { computed } from 'vue';

const canShowUnassign = computed(() => {
  if (!props.canUnassign) return false;
  if (!props.contribution) return false;
  const c = props.contribution;
  if (!c.assigned_contributor_id) return false;
  return c.status === 'assigned';
});
```

- [ ] **Step 3: Wire from parent**

In each ContributionForm call site (CreateContributionDialog.vue, ContributionDetailPage.vue, etc., found via grep in Task 16-prep), pass:

```vue
<ContributionForm
  v-model="showEdit"
  :contribution="editingContribution"
  :can-unassign="canUnassignContributor"
  @submit="handleSave"
  @unassign="confirmUnassign"
/>
```

Handler:

```typescript
function confirmUnassign() {
  showUnassignConfirm.value = true;
}
async function doUnassign() {
  await contributionsStore.unassign(editingContribution.value.id);
  showUnassignConfirm.value = false;
  showEdit.value = false;
}
```

Add a basic Quasar `q-dialog` or use `ConfirmArchiveDialog` (rename props for context):

```vue
<ConfirmArchiveDialog
  v-model="showUnassignConfirm"
  title="Unassign Contributor"
  :message="`This will set the contribution back to 'confirmed' and clear the assigned contributor.`"
  @confirm="doUnassign"
/>
```

(Rename ConfirmArchiveDialog's button label by extending its prop API later if "Archive" doesn't fit — for v1, accept the slight wording mismatch or add a `confirmLabel` prop to `ConfirmArchiveDialog`.)

If you'd prefer better wording, extend `ConfirmArchiveDialog` to accept a `confirmLabel?: string` prop with default `'Archive'`, and pass `'Unassign'` here.

- [ ] **Step 4: Type-check + smoke test**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | head -30`
Expected: clean.

Smoke test: in dev, open a contribution that's assigned, click Edit, see the Unassign block, click Unassign, see status revert to confirmed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/contributions/ContributionForm.vue frontend/src/components/projects/CreateContributionDialog.vue frontend/src/pages/
git commit -m "feat(frontend): contribution edit form with unassign and matching textarea heights"
```

---

## Task 17: Convert AddMilestoneDialog → MilestoneFormDialog

**Files:**
- Rename: `frontend/src/components/projects/AddMilestoneDialog.vue` → `MilestoneFormDialog.vue`
- Modify: all call sites

- [ ] **Step 1: Rename the file via git**

Run:
```bash
cd frontend
git mv src/components/projects/AddMilestoneDialog.vue src/components/projects/MilestoneFormDialog.vue
```

- [ ] **Step 2: Update component to support edit mode**

In `MilestoneFormDialog.vue`:

Change line 9 to:
```vue
<div class="text-h6">{{ isEdit ? 'Edit Milestone' : 'Add Milestone' }}</div>
```

Update Props:
```typescript
import type { Milestone, CreateMilestoneRequest } from 'src/types/projects';
import type { UpdateMilestoneRequest } from 'src/lib/api/implementationPlans';

interface Props {
  modelValue: boolean;
  projectId: string;
  implementationPlanId: string;
  isSubmitting?: boolean;
  milestone?: Milestone | null;
}

const props = withDefaults(defineProps<Props>(), {
  isSubmitting: false,
  milestone: null,
});
```

Add computed:
```typescript
const isEdit = computed(() => !!props.milestone);
```

Update emits:
```typescript
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'submit', req: CreateMilestoneRequest | UpdateMilestoneRequest): void;
}>();
```

Add a watcher to prefill on open in edit mode:
```typescript
watch(
  () => [props.modelValue, props.milestone],
  ([open, ms]) => {
    if (!open) { resetForm(); return; }
    if (ms) {
      const m = ms as Milestone;
      form.value = {
        title: m.title,
        description: m.description ?? '',
        duration: m.duration,
        start_date: m.start_date ? fromISODate(m.start_date) : '',
        end_date: m.end_date ? fromISODate(m.end_date) : '',
        success_criteria: m.success_criteria?.length ? [...m.success_criteria] : [''],
      };
    } else {
      form.value = makeDefault();
    }
  },
  { immediate: true },
);

// ISO yyyy-mm-dd → dd-mm-yyyy for the input mask
function fromISODate(iso: string): string {
  if (!iso || iso.length < 10) return '';
  const [yyyy, mm, dd] = iso.slice(0, 10).split('-');
  return `${dd}-${mm}-${yyyy}`;
}
```

Update the action button label:
```vue
<q-btn
  no-caps
  :label="isEdit ? 'Save Changes' : 'Add Milestone'"
  ...
/>
```

Update `handleSubmit` to emit the right shape based on `isEdit`:
```typescript
function handleSubmit() {
  if (!isValid.value) return;
  const base = {
    title: form.value.title.trim(),
    description: form.value.description.trim() || undefined,
    duration: form.value.duration.trim(),
    start_date: toISODate(form.value.start_date) || undefined,
    end_date: toISODate(form.value.end_date) || undefined,
    success_criteria: form.value.success_criteria.filter((c) => c.trim()),
  };
  emit('submit', base);
}
```

(Backend `UpdateMilestoneRequest` accepts the same field shape; create vs. update is determined at the call site.)

- [ ] **Step 3: Update all call sites**

```bash
grep -rn "AddMilestoneDialog" frontend/src --include="*.vue" --include="*.ts"
```

Replace import paths and component names with `MilestoneFormDialog`. Where milestone editing is needed, pass `:milestone="editingMilestone"` and handle the submit accordingly:

```typescript
async function onMilestoneSubmit(req: CreateMilestoneRequest | UpdateMilestoneRequest) {
  if (editingMilestone.value) {
    await projectsStore.updateMilestone(project.value.id, editingMilestone.value.milestone_id, req);
  } else {
    await projectsStore.addMilestone(planId, project.value.id, req as CreateMilestoneRequest);
  }
  showMilestoneDialog.value = false;
}
```

- [ ] **Step 4: Type-check + smoke test**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/projects/MilestoneFormDialog.vue frontend/src/
git commit -m "feat(frontend): rename AddMilestoneDialog to MilestoneFormDialog with edit mode"
```

---

## Task 18: Pencil + trash icons for milestones, contributions, sub-contributions

**Files:**
- Modify: `frontend/src/pages/Projects/ProjectDetailPage.vue` (or wherever milestones + contributions are rendered as rows/cards)

- [ ] **Step 1: Locate the rendering surfaces**

```bash
grep -rn "v-for.*milestone\|v-for.*contribution" frontend/src/pages/Projects --include="*.vue"
```

Identify the `v-for` blocks rendering each entity type. Likely in `ProjectDetailPage.vue` and possibly nested components.

- [ ] **Step 2: Add icon group to milestone rows**

Inside the milestone `v-for` row, add (gated by permission):

```vue
<div class="row-actions" v-if="canEditMilestone">
  <q-btn
    flat round dense size="sm"
    icon="edit"
    @click="openEditMilestone(milestone)"
  >
    <q-tooltip>Edit milestone</q-tooltip>
  </q-btn>
  <q-btn
    flat round dense size="sm"
    icon="delete"
    color="negative"
    @click="confirmArchiveMilestone(milestone)"
  >
    <q-tooltip>Delete milestone</q-tooltip>
  </q-btn>
</div>
```

Handlers:
```typescript
const editingMilestone = ref<Milestone | null>(null);
const showMilestoneDialog = ref(false);
const showArchiveMilestone = ref(false);
const archivingMilestone = ref<Milestone | null>(null);

function openEditMilestone(ms: Milestone) {
  editingMilestone.value = ms;
  showMilestoneDialog.value = true;
}
function confirmArchiveMilestone(ms: Milestone) {
  archivingMilestone.value = ms;
  showArchiveMilestone.value = true;
}
async function doArchiveMilestone() {
  if (!archivingMilestone.value || !plan.value) return;
  await projectsStore.archiveMilestone(plan.value.id, project.value!.id, archivingMilestone.value.milestone_id);
  showArchiveMilestone.value = false;
  archivingMilestone.value = null;
}

const milestoneArchiveMessage = computed(() => {
  const ms = archivingMilestone.value;
  if (!ms) return '';
  const childContribs = (projectsStore.projectContributions[project.value!.id] ?? [])
    .filter(c => c.milestone_id === ms.milestone_id);
  const subs = childContribs.filter(c => c.parent_contribution).length;
  const tops = childContribs.length - subs;
  return `Archiving "${ms.title}" will also archive ${tops} contribution${tops === 1 ? '' : 's'} and ${subs} sub-contribution${subs === 1 ? '' : 's'}. This cannot be undone from the UI.`;
});
```

In template (somewhere outside the v-for):

```vue
<MilestoneFormDialog
  v-model="showMilestoneDialog"
  :project-id="project?.id ?? ''"
  :implementation-plan-id="plan?.id ?? ''"
  :milestone="editingMilestone"
  @submit="onMilestoneSubmit"
/>

<ConfirmArchiveDialog
  v-model="showArchiveMilestone"
  title="Archive Milestone"
  :message="milestoneArchiveMessage"
  @confirm="doArchiveMilestone"
/>
```

- [ ] **Step 3: Apply same pattern for contribution rows**

For each top-level contribution and sub-contribution rendered:

```vue
<div class="row-actions" v-if="canArchiveContribution">
  <q-btn flat round dense size="sm" icon="edit" @click="openEditContribution(c)">
    <q-tooltip>Edit</q-tooltip>
  </q-btn>
  <q-btn flat round dense size="sm" icon="delete" color="negative" @click="confirmArchiveContribution(c)">
    <q-tooltip>Delete</q-tooltip>
  </q-btn>
</div>
```

Handlers:

```typescript
const editingContribution = ref<Contribution | null>(null);
const showContribDialog = ref(false);
const showArchiveContrib = ref(false);
const archivingContribution = ref<Contribution | null>(null);

function openEditContribution(c: Contribution) {
  editingContribution.value = c;
  showContribDialog.value = true;
}
function confirmArchiveContribution(c: Contribution) {
  archivingContribution.value = c;
  showArchiveContrib.value = true;
}
async function doArchiveContribution() {
  if (!archivingContribution.value) return;
  await contributionsStore.archive(archivingContribution.value.id);
  // Also re-fetch project contributions to refresh sub-contributions
  await projectsStore.fetchProjectContributions(project.value!.id);
  showArchiveContrib.value = false;
  archivingContribution.value = null;
}

const contribArchiveMessage = computed(() => {
  const c = archivingContribution.value;
  if (!c) return '';
  const subs = (projectsStore.projectContributions[project.value!.id] ?? [])
    .filter(x => x.parent_contribution === c.id).length;
  const subText = subs > 0 ? ` and its ${subs} sub-contribution${subs === 1 ? '' : 's'}` : '';
  return `Archiving "${c.title}"${subText} cannot be undone from the UI.`;
});
```

Template:

```vue
<ContributionForm
  v-model="showContribDialog"
  :contribution="editingContribution"
  :can-unassign="canUnassignContributor"
  @submit="onContributionSave"
  @unassign="onUnassignRequested"
/>

<ConfirmArchiveDialog
  v-model="showArchiveContrib"
  title="Archive Contribution"
  :message="contribArchiveMessage"
  @confirm="doArchiveContribution"
/>
```

The Contribution save handler:

```typescript
async function onContributionSave(req: UpdateContributionRequest) {
  if (!editingContribution.value) return;
  await contributionsStore.update(editingContribution.value.id, req);
  showContribDialog.value = false;
}
```

- [ ] **Step 4: Add styles for action group**

```scss
.row-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
```

- [ ] **Step 5: Smoke test all three entity types**

Edit a milestone → save → verify update persists.
Edit a contribution → save → verify update persists.
Edit a sub-contribution → save → verify update persists.
Archive each → verify cascade.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Projects/ProjectDetailPage.vue
git commit -m "feat(frontend): add edit and archive entry points for milestone, contribution, sub-contribution"
```

---

## Task 19: ProjectCompletionSection.vue

**Files:**
- Create: `frontend/src/components/projects/ProjectCompletionSection.vue`
- Modify: `frontend/src/pages/Projects/ProjectDetailPage.vue`

- [ ] **Step 1: Create the section component**

```vue
<template>
  <q-card flat bordered class="completion-section">
    <q-card-section>
      <div class="row items-center q-mb-md">
        <q-icon name="task_alt" color="primary" size="20px" />
        <div class="text-h6 q-ml-sm">Project Completion</div>
      </div>

      <!-- COMPLETED -->
      <div v-if="project.status === 'completed'">
        <q-banner class="bg-green-1">
          <template #avatar>
            <q-icon name="verified" color="positive" />
          </template>
          Completed by {{ project.completed_by || 'a steward' }}
          <span v-if="project.completed_at"> on {{ formatDate(project.completed_at) }}</span>.
        </q-banner>
      </div>

      <!-- PENDING_COMPLETION -->
      <div v-else-if="project.status === 'pending_completion'">
        <q-banner class="bg-orange-1 q-mb-sm">
          <template #avatar><q-icon name="hourglass_top" color="warning" /></template>
          {{ canApprove ? 'Awaiting your signoff.' : 'Awaiting steward signoff.' }}
        </q-banner>
        <div v-if="canApprove" class="row q-gutter-sm">
          <q-btn
            color="positive"
            unelevated
            no-caps
            icon="check"
            label="Approve Completion"
            :loading="approving"
            @click="onApprove"
          />
          <q-btn
            outline
            color="negative"
            no-caps
            icon="undo"
            label="Send Back"
            @click="showRejectDialog = true"
          />
        </div>
      </div>

      <!-- ACTIVE -->
      <div v-else-if="project.status === 'active'">
        <div v-if="project.rejection_reason" class="q-mb-sm">
          <q-banner class="bg-yellow-1">
            <template #avatar><q-icon name="info" color="warning" /></template>
            <strong>Steward sent back:</strong> {{ project.rejection_reason }}
          </q-banner>
        </div>
        <div v-if="!allSignedOff" class="text-grey-8">
          {{ signedOffCount }} / {{ totalContributions }} contributions signed off.
          {{ totalContributions === 0 ? '' : 'Submit for review once all are complete.' }}
        </div>
        <div v-else>
          <p class="q-mb-sm">All contributions are signed off and ready for steward review.</p>
          <div v-if="canSubmit">
            <q-btn
              color="primary"
              unelevated
              no-caps
              icon="send"
              label="Submit for Steward Review"
              :loading="submitting"
              @click="onSubmit"
            />
          </div>
          <div v-else class="text-grey-8">
            Awaiting the project lead to submit for steward review.
          </div>
        </div>
      </div>
    </q-card-section>

    <!-- Reject dialog -->
    <q-dialog v-model="showRejectDialog">
      <q-card style="min-width: 420px">
        <q-card-section>
          <div class="text-h6">Send Back for Revision</div>
        </q-card-section>
        <q-card-section>
          <q-input
            v-model="rejectReason"
            label="Reason (optional)"
            type="textarea"
            outlined
            autogrow
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn
            color="negative"
            unelevated
            label="Send Back"
            :loading="rejecting"
            @click="onReject"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-card>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Project, Contribution } from 'src/types/projects';

const props = defineProps<{
  project: Project;
  contributions: Contribution[];
  canSubmit: boolean;
  canApprove: boolean;
}>();

const emit = defineEmits<{
  submit: [];
  approve: [];
  reject: [reason: string];
}>();

const submitting = ref(false);
const approving = ref(false);
const rejecting = ref(false);
const showRejectDialog = ref(false);
const rejectReason = ref('');

const totalContributions = computed(() => props.contributions.length);
const signedOffCount = computed(
  () => props.contributions.filter(c => c.status === 'signed_off' || c.status === 'archived').length,
);
const allSignedOff = computed(
  () => totalContributions.value > 0 && signedOffCount.value === totalContributions.value,
);

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}

async function onSubmit() {
  submitting.value = true;
  try { emit('submit'); } finally { submitting.value = false; }
}
async function onApprove() {
  approving.value = true;
  try { emit('approve'); } finally { approving.value = false; }
}
async function onReject() {
  rejecting.value = true;
  try {
    emit('reject', rejectReason.value);
    showRejectDialog.value = false;
    rejectReason.value = '';
  } finally {
    rejecting.value = false;
  }
}
</script>

<style scoped lang="scss">
.completion-section {
  margin: 16px 0;
}
</style>
```

- [ ] **Step 2: Wire into ProjectDetailPage.vue**

Add the section to the template (place near the bottom of the project info area):

```vue
<ProjectCompletionSection
  v-if="project"
  :project="project"
  :contributions="projectContributions"
  :can-submit="canSubmitProjectCompletion"
  :can-approve="canApproveProjectCompletion"
  @submit="onSubmitCompletion"
  @approve="onApproveCompletion"
  @reject="onRejectCompletion"
/>
```

In script:

```typescript
import ProjectCompletionSection from 'src/components/projects/ProjectCompletionSection.vue';

const projectContributions = computed(() => projectsStore.projectContributions[project.value?.id ?? ''] ?? []);

async function onSubmitCompletion() {
  if (!project.value) return;
  await projectsStore.submitCompletion(project.value.id);
}
async function onApproveCompletion() {
  if (!project.value) return;
  await projectsStore.approveCompletion(project.value.id);
}
async function onRejectCompletion(reason: string) {
  if (!project.value) return;
  await projectsStore.rejectCompletion(project.value.id, reason);
}
```

- [ ] **Step 3: Add status badge styling for `pending_completion`**

Search for the project status pill component:

```bash
grep -rn "ProjectStatus\|status-badge\|status === 'completed'" frontend/src/components/projects --include="*.vue" | head -10
```

Find the existing status badge (likely a small `<span>` or `<q-chip>` per status). Add `pending_completion`:

Example (adapt to existing component structure):

```vue
<q-chip
  v-if="project.status === 'pending_completion'"
  color="orange"
  text-color="white"
  icon="hourglass_top"
  label="Pending Signoff"
  dense
/>
```

Or in a switch-style component, add a case for `pending_completion` with amber/warning styling.

- [ ] **Step 4: Smoke test the full flow**

Sign off all contributions on a project. As a lead, see "Submit for Steward Review" → click → status goes to `pending_completion`. As a steward, see "Approve" + "Send Back". Click Send Back, type a reason, see status revert to `active` with the reason banner. Re-submit → see reason cleared. Click Approve → see "Completed by ... on ...".

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/projects/ProjectCompletionSection.vue frontend/src/pages/Projects/ProjectDetailPage.vue frontend/src/components/projects/
git commit -m "feat(frontend): add project completion submit/approve/reject flow with steward signoff"
```

---

## Task 20: Verify proposal form input height parity (item 5 cross-check)

**Files:**
- Read: `frontend/src/components/proposals/CreateProposalDialog.vue`
- (Possibly modify) `frontend/src/components/contributions/ContributionForm.vue`

- [ ] **Step 1: Inspect proposal form attributes**

Run:
```bash
grep -B 1 -A 6 "Objective\|Deliverable\|Acceptance" frontend/src/components/proposals/CreateProposalDialog.vue
```

Compare attributes (textarea/autogrow/dense/outlined/min-rows) to what you set in Task 16.

- [ ] **Step 2: Make them identical**

If proposal uses `min-rows="2"` or similar, mirror in contribution form (or vice versa). Goal: same visual height for the same field type across both forms.

- [ ] **Step 3: Visual check**

Run dev: `cd frontend && npm run dev`. Open a proposal create dialog, then a contribution edit dialog, and visually compare Objective/Deliverable/Acceptance Criteria input heights at idle (one row) and after typing (auto-grown).

- [ ] **Step 4: Commit (only if changes were made)**

```bash
git add frontend/src/components/
git commit -m "style(frontend): match input heights between proposal and contribution forms"
```

---

## Task 21: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Backend tests**

```bash
cd backend && make test
```
Expected: all pass.

- [ ] **Step 2: Backend integration tests (optional but recommended)**

```bash
cd backend && make test-integration
```
Expected: all pass.

- [ ] **Step 3: Frontend lint + typecheck**

```bash
cd frontend && npm run lint && npx vue-tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Frontend E2E smoke**

```bash
cd frontend && npm run test -- --grep="contribution|project" 2>&1 | tail -40
```
Expected: existing tests still pass.

- [ ] **Step 5: Manual end-to-end checklist (dev mode)**

Run dev servers, then walk through:

1. Login as admin (`anger shock rubber thunder lonely scheme device neck anchor rain radar heart`).
2. Open an existing project, click Edit → Delete Project → see DESTROY dialog → type DESTROY → confirm. Verify project disappears and is `archived` in backend (`curl http://localhost:8080/api/v1/projects | jq '.projects[] | select(.status == "archived")'`).
3. On another project, click pencil on a milestone → edit title → save → see change. Click trash → confirm dialog → archive → see milestone disappear.
4. Same for top-level contribution and sub-contribution.
5. On a contribution that's `assigned`, click Edit → see Unassign Contributor button → confirm → see status flip to `confirmed`, assignee cleared.
6. Sign off all contributions on a project → as lead, see "Submit for Steward Review" → click → status becomes `pending_completion`.
7. As a steward (`ship drop ankle stand minute song web easy nose object render measure`), see Approve/Send Back. Send back with reason → as lead, see banner with reason. Re-submit. Approve → see Completed by + date.
8. Open contribution edit form vs proposal create dialog side-by-side; verify Objective/Deliverable/Acceptance Criteria fields look the same height.

- [ ] **Step 6: Final commit if any small fixes were needed during walk-through**

```bash
git status
# If anything changed:
git add -p
git commit -m "fix(contributions): polish from end-to-end walkthrough"
```

---

## Spec coverage check

| Spec section | Tasks |
| --- | --- |
| 1. Delete project (DESTROY) | 1, 2, 3, 6, 9, 10, 11, 12, 13, 15 |
| 2. Edit + archive milestone/contribution/sub-contribution | 1, 2, 4, 7, 8, 9, 10, 11, 12, 14, 16, 17, 18 |
| 3. Unassign contributor | 2, 4, 7, 10, 11, 12, 16 |
| 4. Submit project complete (lead → steward) | 1, 2, 5, 6, 9, 10, 11, 12, 19 |
| 5. Equalize input heights | 16, 20 |

All five spec items have at least one implementation task plus tests where applicable.
