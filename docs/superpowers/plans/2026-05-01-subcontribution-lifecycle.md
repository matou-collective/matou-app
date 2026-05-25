# Sub-Contribution Lifecycle Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sub-contributions assignable to any community member (not just the parent's assignee), captured in the create form and editable before approval. Remove the backend's auto-inherit fallback so approval requires an explicit assignee. Allow re-approval after a lead-edit.

**Architecture:** Subs share the same backend state machine as top-level contributions, with a different entry edge (`created → assigned` and `changed → assigned`, skipping `confirmed`/`shared`/`offered`). The contributor lives in the existing `assigned_contributor_id` field even while in `created`. The Create dialog grows a contributor picker (defaulted to parent's contributor) that only appears in the sub-creation case. Approve buttons are disabled when no contributor is set.

**Tech Stack:** Go (backend service, validation), Vue 3 + Quasar + Pinia (frontend), TypeScript, Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-05-01-subcontribution-lifecycle-design.md`

---

## File Map

**Backend (modify):**
- `backend/internal/contributions/service.go` — `CreateContributionRequest` struct + `CreateContribution`, `ApproveSubContribution`
- `backend/internal/contributions/service_test.go` — new tests for both flows

**Frontend (modify):**
- `frontend/src/lib/api/contributions.ts` — `CreateContributionRequest` TS type
- `frontend/src/composables/useContributionWorkflow.ts` — `canApproveSub`
- `frontend/src/components/projects/CreateContributionDialog.vue` — contributor picker (sub-only)
- `frontend/src/pages/Projects/ProjectDetailPage.vue` — pass parent's contributor into the create dialog
- `frontend/src/components/projects/ContributionDetailDialog.vue` — disable Approve when no assignee + show assignee avatar
- `frontend/src/components/projects/ContributionCardCompact.vue` — disable Approve when no assignee + show assignee avatar (already has avatar logic)

**No new files.**

---

## Task 1: Backend — Accept `assigned_contributor_id` on contribution creation

**Files:**
- Modify: `backend/internal/contributions/service.go:1085-1123` (`CreateContributionRequest` struct + `CreateContribution` body)
- Test: `backend/internal/contributions/service_test.go` (add a new test function)

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/contributions/service_test.go`:

```go
func TestCreateContribution_StoresAssignedContributorID(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "test-space"

	req := &CreateContributionRequest{
		ProjectID:        "proj-1",
		Title:            "test",
		Description:      "desc",
		ContributionType: ProposalTypeCodingTechnicalDev,
		Priority:         PriorityMedium,
		CreatedBy:        "creator-aid",
		Objectives:       []string{"o1"},
		Deliverables:     []string{"d1"},
		AssignedContributorID: "assignee-aid",
	}

	c, err := svc.CreateContribution(ctx, spaceID, req)
	if err != nil {
		t.Fatalf("CreateContribution failed: %v", err)
	}
	if c.AssignedContributorID != "assignee-aid" {
		t.Errorf("expected assignee-aid, got %q", c.AssignedContributorID)
	}
	if c.Status != ContribCreated {
		t.Errorf("expected status created, got %s", c.Status)
	}
}
```

The setup mirrors the pattern used in `TestService_CreateProposal` (top of `service_test.go`): `NewService(NewMockStore())` is the public constructor + in-memory store. `ProposalTypeTechnical` and `PriorityMedium` are real constants from `models.go`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && go test ./internal/contributions -run TestCreateContribution_StoresAssignedContributorID -v
```

Expected: FAIL — `unknown field 'AssignedContributorID' in struct literal of type CreateContributionRequest`.

- [ ] **Step 3: Add the field to `CreateContributionRequest`**

In `backend/internal/contributions/service.go` around line 1085:

```go
type CreateContributionRequest struct {
	ProjectID             string       `json:"project_id"`
	Title                 string       `json:"title"`
	Description           string       `json:"description"`
	ContributionType      ProposalType `json:"contribution_type"`
	Priority              Priority     `json:"priority"`
	CreatedBy             string       `json:"created_by"`
	Objectives            []string     `json:"objectives"`
	Deliverables          []string     `json:"deliverables"`
	AcceptanceCriteria    []string     `json:"acceptance_criteria"`
	SkillRequirements     []string     `json:"skill_requirements"`
	MilestoneID           string       `json:"milestone_id,omitempty"`
	ParentContributionID  string       `json:"parent_contribution,omitempty"`
	AssignedContributorID string       `json:"assigned_contributor_id,omitempty"`
	EstimatedDuration     int          `json:"estimated_duration,omitempty"`
	Tags                  []string     `json:"tags,omitempty"`
}
```

- [ ] **Step 4: Persist the field on creation**

In `CreateContribution` (around line 1102), add `AssignedContributorID` to the struct literal:

```go
c := &Contribution{
    ID:                    generateID("ctr"),
    ProjectID:             req.ProjectID,
    Title:                 req.Title,
    Description:           req.Description,
    ContributionType:      req.ContributionType,
    Priority:              req.Priority,
    CreatedBy:             req.CreatedBy,
    Objectives:            req.Objectives,
    Deliverables:          req.Deliverables,
    AcceptanceCriteria:    req.AcceptanceCriteria,
    SkillRequirements:     req.SkillRequirements,
    MilestoneID:           req.MilestoneID,
    ParentContributionID:  req.ParentContributionID,
    AssignedContributorID: req.AssignedContributorID,
    EstimatedDuration:     req.EstimatedDuration,
    Tags:                  req.Tags,
    Status:                ContribCreated,
    CreatedAt:             now,
    UpdatedAt:             now,
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd backend && go test ./internal/contributions -run TestCreateContribution_StoresAssignedContributorID -v
```

Expected: PASS.

- [ ] **Step 6: Run the full contributions package tests to confirm nothing else broke**

```bash
cd backend && go test ./internal/contributions -v
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/contributions/service.go backend/internal/contributions/service_test.go
git commit -m "feat(backend): accept assigned_contributor_id on contribution creation"
```

---

## Task 2: Backend — `ApproveSubContribution` requires explicit assignee + supports re-approval

**Files:**
- Modify: `backend/internal/contributions/service.go:1542-1577`
- Test: `backend/internal/contributions/service_test.go` (add three test functions)

- [ ] **Step 1: Write the three failing tests**

Add to `backend/internal/contributions/service_test.go`:

```go
func TestApproveSubContribution_UsesChildOwnAssignee(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "test-space"

	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "parent",
		Description:           "p",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		AssignedContributorID: "parent-assignee",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	child, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "child",
		Description:           "c",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		ParentContributionID:  parent.ID,
		AssignedContributorID: "different-assignee",
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}

	approved, err := svc.ApproveSubContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if approved.Status != ContribAssigned {
		t.Errorf("expected status assigned, got %s", approved.Status)
	}
	if approved.AssignedContributorID != "different-assignee" {
		t.Errorf("expected child's own assignee 'different-assignee', got %q", approved.AssignedContributorID)
	}
}

func TestApproveSubContribution_NoAssigneeReturnsError(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "test-space"

	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "parent",
		Description:           "p",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		AssignedContributorID: "parent-assignee",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	child, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:            "proj-1",
		Title:                "child",
		Description:          "c",
		ContributionType:     ProposalTypeTechnical,
		Priority:             PriorityMedium,
		CreatedBy:            "creator",
		Objectives:           []string{"o"},
		Deliverables:         []string{"d"},
		ParentContributionID: parent.ID,
		// AssignedContributorID intentionally omitted
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}

	_, err = svc.ApproveSubContribution(ctx, spaceID, child.ID)
	if err == nil {
		t.Fatal("expected error when sub has no assignee, got nil")
	}
	if !strings.Contains(err.Error(), "assigned contributor") {
		t.Errorf("error should mention assigned contributor, got: %v", err)
	}
}

func TestApproveSubContribution_AllowsReApprovalFromChanged(t *testing.T) {
	ctx := context.Background()
	svc := NewService(NewMockStore())
	spaceID := "test-space"

	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "parent",
		Description:           "p",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		AssignedContributorID: "parent-assignee",
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	child, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:             "proj-1",
		Title:                 "child",
		Description:           "c",
		ContributionType:      ProposalTypeTechnical,
		Priority:              PriorityMedium,
		CreatedBy:             "creator",
		Objectives:            []string{"o"},
		Deliverables:          []string{"d"},
		ParentContributionID:  parent.ID,
		AssignedContributorID: "child-assignee",
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	if _, err := svc.ApproveSubContribution(ctx, spaceID, child.ID); err != nil {
		t.Fatalf("first approve: %v", err)
	}
	// Simulate a lead-edit putting the contribution into 'changed' via the
	// existing transition method (assigned → changed is a valid transition).
	if _, err := svc.TransitionContribution(ctx, spaceID, child.ID, ContribChanged); err != nil {
		t.Fatalf("transition to changed: %v", err)
	}

	approved, err := svc.ApproveSubContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("re-approve: %v", err)
	}
	if approved.Status != ContribAssigned {
		t.Errorf("expected status assigned, got %s", approved.Status)
	}
}
```

Add `"strings"` to the imports of `service_test.go` if not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/contributions -run "TestApproveSubContribution_(UsesChildOwnAssignee|NoAssigneeReturnsError|AllowsReApprovalFromChanged)" -v
```

Expected:
- `UsesChildOwnAssignee`: FAIL — current code overwrites with parent's assignee.
- `NoAssigneeReturnsError`: FAIL — current code falls back to parent's, no error.
- `AllowsReApprovalFromChanged`: FAIL — current code rejects non-`created` source.

- [ ] **Step 3: Refactor `ApproveSubContribution`**

In `backend/internal/contributions/service.go` around line 1544, replace the function body:

```go
// ApproveSubContribution transitions a sub-contribution from created/changed to assigned.
// Requires the child to already have an explicit assigned_contributor_id (set at creation
// or during a pre-approval edit). The parent-fallback behavior has been removed.
func (s *Service) ApproveSubContribution(ctx context.Context, spaceID, contributionID string) (*Contribution, error) {
	child, err := s.GetContribution(ctx, spaceID, contributionID)
	if err != nil {
		return nil, fmt.Errorf("contribution not found: %w", err)
	}
	if child.ParentContributionID == "" {
		return nil, fmt.Errorf("contribution %s is not a sub-contribution (no parent)", contributionID)
	}
	if child.Status != ContribCreated && child.Status != ContribChanged {
		return nil, fmt.Errorf("sub-contribution must be in created or changed status to approve, current: %s", child.Status)
	}
	if child.AssignedContributorID == "" {
		return nil, fmt.Errorf("sub-contribution must have an assigned contributor before approval")
	}
	if err := ValidateContributionTransition(child.Status, ContribAssigned); err != nil {
		return nil, err
	}
	child.Status = ContribAssigned
	child.UpdatedAt = time.Now()
	if err := s.store.Save(spaceID, child.ID, "contribution", child); err != nil {
		return nil, fmt.Errorf("saving contribution: %w", err)
	}
	return child, nil
}
```

Note: this removes the parent lookup entirely. The parent's `AssignedContributorID` is no longer consulted — the child carries its own.

- [ ] **Step 4: Run the new tests**

```bash
cd backend && go test ./internal/contributions -run "TestApproveSubContribution_(UsesChildOwnAssignee|NoAssigneeReturnsError|AllowsReApprovalFromChanged)" -v
```

Expected: All three PASS.

- [ ] **Step 5: Run the full contributions package tests**

```bash
cd backend && go test ./internal/contributions -v
```

Expected: All tests pass. If any pre-existing test fails because it relied on the old auto-inherit behavior, update that test to set `AssignedContributorID` explicitly when creating the child.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/contributions/service.go backend/internal/contributions/service_test.go
git commit -m "feat(backend): require explicit assignee for sub-contribution approval; allow re-approval from changed"
```

---

## Task 3: Frontend — `CreateContributionRequest` TS field

**Files:**
- Modify: `frontend/src/lib/api/contributions.ts:17-30`

- [ ] **Step 1: Add the optional field to the request type**

In `frontend/src/lib/api/contributions.ts`, replace the existing `CreateContributionRequest` interface:

```ts
export interface CreateContributionRequest {
  project_id: string;
  milestone_id?: string;
  title: string;
  description: string;
  contribution_type: string;
  objectives: string[];
  deliverables: string[];
  acceptance_criteria: string[];
  skill_requirements: string[];
  estimated_hours?: number;
  budget?: string;
  created_by: string;
  assigned_contributor_id?: string;
}
```

- [ ] **Step 2: Verify type-check passes**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "contributions\.ts|CreateContributionRequest"
```

Expected: no new errors related to this change. (Pre-existing unrelated errors in other files are OK.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/api/contributions.ts
git commit -m "feat(frontend): add assigned_contributor_id to CreateContributionRequest"
```

---

## Task 4: Frontend — `canApproveSub` requires assignee + accepts changed

**Files:**
- Modify: `frontend/src/composables/useContributionWorkflow.ts:142-151`

- [ ] **Step 1: Update `canApproveSub`**

In `frontend/src/composables/useContributionWorkflow.ts`, replace the `canApproveSub` function:

```ts
/**
 * Lead or admin can approve a sub-contribution that is in `created` or `changed`
 * status, but only when an assigned_contributor_id is set on the sub.
 */
function canApproveSub(contribution: Contribution, role: ProjectRole | string): boolean {
  if (!contribution.parent_contribution) return false;
  if (contribution.status !== 'created' && contribution.status !== 'changed') return false;
  const assignee = contribution.assigned_contributor_id ?? contribution.assigned_contributor;
  if (!assignee) return false;
  return _isRole(role, LEAD_ROLES);
}
```

Note: the function reads `assigned_contributor` as a fallback because some places in the codebase use the un-suffixed field name. Confirm which exists on the `Contribution` type (`grep -n "assigned_contributor" frontend/src/types/projects.ts`); if only `assigned_contributor_id` exists, drop the fallback.

- [ ] **Step 2: Verify type-check passes**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "useContributionWorkflow"
```

Expected: no errors in this file.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/composables/useContributionWorkflow.ts
git commit -m "feat(frontend): canApproveSub requires assignee, accepts changed status"
```

---

## Task 5: Frontend — Contributor picker in `CreateContributionDialog.vue`

**Files:**
- Modify: `frontend/src/components/projects/CreateContributionDialog.vue` (props, template, script)

- [ ] **Step 1: Add `parentAssignedContributorId` prop**

In `CreateContributionDialog.vue`, replace the `Props` interface (around line 288):

```ts
interface Props {
  modelValue: boolean;
  projectId: string;
  milestoneId?: string;
  parentContributionId?: string;
  parentAssignedContributorId?: string;
  isSubmitting?: boolean;
  editing?: boolean;
  contribution?: Contribution | null;
}
```

And update the `withDefaults` block (around line 298) to include the new default:

```ts
const props = withDefaults(defineProps<Props>(), {
  milestoneId: undefined,
  parentContributionId: undefined,
  parentAssignedContributorId: undefined,
  isSubmitting: false,
  editing: false,
  contribution: null,
});
```

- [ ] **Step 2: Add `assigned_contributor_id` to the form state**

Around line 312, extend the `ContributionForm` interface and `makeDefault`:

```ts
interface ContributionForm {
  title: string;
  description: string;
  contribution_type: string;
  estimated_hours: number | undefined;
  deadline: string;
  budget: string;
  objectives: string[];
  deliverables: string[];
  acceptance_criteria: string[];
  skill_requirements: string[];
  assigned_contributor_id: string;
}

function makeDefault(): ContributionForm {
  return {
    title: '',
    description: '',
    contribution_type: 'coding_technical_dev',
    estimated_hours: undefined,
    deadline: '',
    budget: '',
    objectives: [''],
    deliverables: [''],
    acceptance_criteria: [''],
    skill_requirements: [''],
    assigned_contributor_id: '',
  };
}
```

- [ ] **Step 3: Pre-fill the assignee with the parent's contributor when opening for a sub**

Update the `watch` block at the bottom of the `<script setup>` (around line 382). When the dialog opens and `parentContributionId` is set (sub-create mode), seed `form.value.assigned_contributor_id` from `props.parentAssignedContributorId`:

```ts
watch(
  () => props.modelValue,
  (open) => {
    if (open && props.editing && props.contribution) {
      const c = props.contribution;
      form.value.title = c.title || '';
      form.value.description = c.description || '';
      form.value.contribution_type = c.contribution_type || 'coding_technical_dev';
      form.value.estimated_hours = c.estimated_hours ?? undefined;
      form.value.deadline = c.deadline ? c.deadline.split('-').reverse().join('-') : '';
      form.value.budget = c.budget || '';
      form.value.objectives = c.objectives?.length ? [...c.objectives] : [''];
      form.value.deliverables = c.deliverables?.length ? [...c.deliverables] : [''];
      form.value.acceptance_criteria = c.acceptance_criteria?.length ? [...c.acceptance_criteria] : [''];
      form.value.skill_requirements = c.skill_requirements?.length ? [...c.skill_requirements] : [''];
      form.value.assigned_contributor_id = c.assigned_contributor_id ?? '';
      changeReason.value = '';
    } else if (open && props.parentContributionId) {
      // Sub-create mode: pre-fill the picker with the parent's contributor
      resetForm();
      form.value.assigned_contributor_id = props.parentAssignedContributorId ?? '';
    } else if (!open) {
      resetForm();
      changeReason.value = '';
    }
  },
);
```

- [ ] **Step 4: Add the picker UI (sub-create mode only)**

In the `<template>`, find the section right after the type selector (around line 67, before the "Duration & Deadline" inline-row at line 68). Insert a new section:

```vue
<!-- Contributor picker (sub-create mode only) -->
<div v-if="parentContributionId && !editing">
  <div class="text-subtitle2 q-mb-sm">Assigned Contributor *</div>
  <q-select
    v-model="form.assigned_contributor_id"
    :options="contributorOptions"
    option-label="label"
    option-value="value"
    emit-value
    map-options
    outlined
    use-input
    input-debounce="120"
    @filter="filterContributors"
    placeholder="Search community members"
  />
  <div class="text-caption text-grey-6 q-mt-xs">
    Defaults to the parent's contributor. Pick someone else to ask for help on this piece.
  </div>
</div>
```

- [ ] **Step 5: Wire the picker to the profiles store**

Add to the imports at the top of `<script setup>` (around line 282):

```ts
import { useProfilesStore } from 'stores/profiles';
```

After the existing `props`/`emit` declarations (around line 310), add:

```ts
const profilesStore = useProfilesStore();

interface ContributorOption {
  label: string;
  value: string;
}

const allContributorOptions = computed<ContributorOption[]>(() =>
  profilesStore.communityProfiles.map((p) => {
    const aid = (p.data?.aid as string) ?? '';
    const name = (p.data?.displayName as string) ?? aid.slice(0, 12) + '...';
    return { label: name, value: aid };
  }).filter(o => o.value),
);

const contributorOptions = ref<ContributorOption[]>([]);

function filterContributors(needle: string, update: (cb: () => void) => void) {
  update(() => {
    const q = needle.trim().toLowerCase();
    contributorOptions.value = q
      ? allContributorOptions.value.filter((o) => o.label.toLowerCase().includes(q))
      : allContributorOptions.value;
  });
}

// Ensure community profiles are loaded so the picker has options
watch(
  () => props.modelValue,
  (open) => {
    if (open && props.parentContributionId && profilesStore.communityProfiles.length === 0) {
      void profilesStore.loadCommunityProfiles();
    }
  },
  { immediate: true },
);
```

- [ ] **Step 6: Validate the picker is filled in sub-create mode**

Update the `isValid` computed (around line 373) to require an assignee in sub-create mode:

```ts
const isValid = computed(
  () => {
    const baseValid =
      form.value.title.trim().length > 0 &&
      form.value.description.trim().length > 0 &&
      !!form.value.contribution_type &&
      form.value.objectives.some((o) => o.trim()) &&
      form.value.deliverables.some((d) => d.trim());
    if (!baseValid) return false;
    if (props.parentContributionId && !props.editing) {
      return !!form.value.assigned_contributor_id;
    }
    return true;
  },
);
```

- [ ] **Step 7: Include `assigned_contributor_id` in the submit payload**

Update `handleSubmit` (around line 432) — the `req: CreateContributionRequest` literal — to include the field when set:

```ts
const req: CreateContributionRequest = {
  project_id: props.projectId,
  milestone_id: props.milestoneId,
  title: form.value.title.trim(),
  description: form.value.description.trim(),
  contribution_type: form.value.contribution_type,
  priority: 'medium',
  objectives: form.value.objectives.filter((o) => o.trim()),
  deliverables: form.value.deliverables.filter((d) => d.trim()),
  acceptance_criteria: form.value.acceptance_criteria.filter((a) => a.trim()),
  skill_requirements: form.value.skill_requirements.filter((s) => s.trim()),
  estimated_hours: form.value.estimated_hours,
  budget: form.value.budget.trim() || undefined,
  created_by: 'current-user',
  ...(form.value.assigned_contributor_id ? { assigned_contributor_id: form.value.assigned_contributor_id } : {}),
};
emit('submit', req);
```

- [ ] **Step 8: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "CreateContributionDialog"
```

Expected: no errors in `CreateContributionDialog.vue`.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/projects/CreateContributionDialog.vue
git commit -m "feat(frontend): contributor picker in sub-contribution create dialog"
```

---

## Task 6: Frontend — Pass parent's contributor into the create dialog

**Files:**
- Modify: `frontend/src/pages/Projects/ProjectDetailPage.vue` (the `<CreateContributionDialog v-model="showCreateSubDialog">` block + a new computed)

- [ ] **Step 1: Add a computed for the parent's contributor**

In `frontend/src/pages/Projects/ProjectDetailPage.vue`, near the existing sub-related state (search for `createSubParentId`), add:

```ts
const createSubParentContributor = computed<string | undefined>(() => {
  const pid = createSubParentId.value;
  if (!pid) return undefined;
  const parent = allProjectContributions.value.find(c => c.id === pid);
  return parent?.assigned_contributor_id ?? undefined;
});
```

- [ ] **Step 2: Pass the new prop into the sub-create dialog**

In the same file, update the second `<CreateContributionDialog>` block (the one with `:parent-contribution-id="createSubParentId"`, around line 329):

```vue
<CreateContributionDialog
  v-model="showCreateSubDialog"
  :project-id="project?.id ?? ''"
  :parent-contribution-id="createSubParentId"
  :parent-assigned-contributor-id="createSubParentContributor"
  :is-submitting="creatingContribution"
  @submit="handleCreateSubContributionSubmit"
/>
```

- [ ] **Step 3: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "ProjectDetailPage"
```

Expected: no new errors.

- [ ] **Step 4: Smoke-test in dev**

Open a contribution that has an assigned contributor → click "Add Sub-Contribution" → verify the picker appears and is pre-filled with the parent's contributor's name.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Projects/ProjectDetailPage.vue
git commit -m "feat(frontend): pass parent's contributor as default into sub-create dialog"
```

---

## Task 7: Frontend — Disable Approve buttons + show suggested assignee

**Files:**
- Modify: `frontend/src/components/projects/ContributionDetailDialog.vue` (sub-list row Approve button)
- Modify: `frontend/src/components/projects/ContributionCardCompact.vue` (Approve in collapsible section)

- [ ] **Step 1: Update Approve in `ContributionDetailDialog.vue`**

Find the sub-list Approve button (around line 286). Replace with a version that disables when no assignee and explains why via tooltip. Add a small assignee chip just before the button.

The current row:

```vue
<div
  v-for="child in childContributions"
  :key="child.id"
  class="sub-item clickable"
  @click="selectedChildContribution = child"
>
  <div class="sub-item-badges">
    <ContributionStatusBadge :status="child.status" />
  </div>
  <span class="sub-item-title">{{ child.title }}</span>
  <q-btn
    v-if="canApproveSub && child.status === 'created'"
    outline
    no-caps
    label="Approve"
    color="primary"
    class="approve-sub-btn"
    :loading="actionLoading === `approve-sub-${child.id}`"
    @click.stop="handleApproveSub(child.id)"
  />
  <template v-if="canApproveSub">
    <q-btn
      flat round dense size="sm"
      icon="edit"
      @click.stop="emit('edit-sub-contribution', child)"
    >
      <q-tooltip>Edit Sub-Contribution</q-tooltip>
    </q-btn>
  </template>
</div>
```

Becomes:

```vue
<div
  v-for="child in childContributions"
  :key="child.id"
  class="sub-item clickable"
  @click="selectedChildContribution = child"
>
  <div class="sub-item-badges">
    <ContributionStatusBadge :status="child.status" />
  </div>
  <span class="sub-item-title">{{ child.title }}</span>
  <span v-if="child.assigned_contributor_id" class="sub-item-assignee" @click.stop>
    <q-tooltip>Will be assigned to {{ assigneeName(child) }}</q-tooltip>
    <span class="sub-item-assignee-name">{{ assigneeName(child) }}</span>
  </span>
  <q-btn
    v-if="canApproveSub && (child.status === 'created' || child.status === 'changed')"
    outline
    no-caps
    label="Approve"
    color="primary"
    class="approve-sub-btn"
    :disable="!child.assigned_contributor_id"
    :loading="actionLoading === `approve-sub-${child.id}`"
    @click.stop="handleApproveSub(child.id)"
  >
    <q-tooltip v-if="!child.assigned_contributor_id">
      Assign a contributor first
    </q-tooltip>
  </q-btn>
  <template v-if="canApproveSub">
    <q-btn
      flat round dense size="sm"
      icon="edit"
      @click.stop="emit('edit-sub-contribution', child)"
    >
      <q-tooltip>Edit Sub-Contribution</q-tooltip>
    </q-btn>
  </template>
</div>
```

Add a helper next to the existing computed properties (around line 1107, after `childContributions`):

```ts
function assigneeName(c: Contribution): string {
  const aid = c.assigned_contributor_id ?? c.assigned_contributor;
  if (!aid) return '';
  const profile = profilesStore.profilesByAid[aid];
  return profile?.displayName || aid.slice(0, 12) + '…';
}
```

If `profilesStore` isn't already imported/used in this file, add:

```ts
import { useProfilesStore } from 'stores/profiles';
const profilesStore = useProfilesStore();
```

(Check existing imports first — `grep -n "useProfilesStore" frontend/src/components/projects/ContributionDetailDialog.vue` — and skip if already there.)

Add minimal styles at the end of `<style scoped lang="scss">` (search for `.approve-sub-btn` near line 2353):

```scss
.sub-item-assignee {
  display: inline-flex;
  align-items: center;
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  padding: 2px 6px;
  background: var(--matou-secondary);
  border-radius: 8px;
}

.sub-item-assignee-name {
  white-space: nowrap;
}
```

- [ ] **Step 2: Update Approve in `ContributionCardCompact.vue`**

Find the Approve button added in the previous commit (search for `'approve-sub'` in `ContributionCardCompact.vue`). Update with `:disable` + tooltip:

```vue
<q-btn
  v-if="isSubContribution && isLead && (contribution.status === 'created' || contribution.status === 'changed')"
  outline
  no-caps
  label="Approve"
  color="primary"
  class="confirm-btn"
  :disable="!contribution.assigned_contributor_id"
  @click.stop="emit('update', { ...contribution, _action: 'approve-sub' })"
>
  <q-tooltip v-if="!contribution.assigned_contributor_id">
    Assign a contributor first
  </q-tooltip>
</q-btn>
```

Note: this card already shows the assigned avatar via `compact-avatar` (search for `assignedAid`) — no additional UI needed for the assignee display.

- [ ] **Step 3: Type-check**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "ContributionDetailDialog|ContributionCardCompact"
```

Expected: no new errors.

- [ ] **Step 4: Smoke-test in dev**

1. Create a sub without an assignee (skip the picker — set assignee blank in the form). Approve button should be disabled with the tooltip "Assign a contributor first".
2. Edit the sub, set an assignee, save. Approve button should be enabled. Click Approve → status moves to `assigned`.
3. Lead-edit the assigned sub (changes title) → status goes to `changed`. Approve button reappears (now enabled because the assignee is still set). Approve → back to `assigned`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/projects/ContributionDetailDialog.vue frontend/src/components/projects/ContributionCardCompact.vue
git commit -m "feat(frontend): disable Approve when sub has no assignee; show assignee on rows"
```

---

## Task 8: Verify end-to-end

- [ ] **Step 1: Run all backend tests**

```bash
cd backend && go test ./...
```

Expected: all PASS. Triage any failures specific to this work.

- [ ] **Step 2: Type-check the frontend**

```bash
cd frontend && npx vue-tsc --noEmit 2>&1 | tail -40
```

Expected: no NEW errors from the files in this plan. Pre-existing errors elsewhere are out of scope.

- [ ] **Step 3: Smoke test the dev UI**

Walk through the full flow:

1. **"Break my work into pieces"** — assigned contributor opens parent → Add Sub-Contribution → picker pre-fills with their own AID → Submit → lead clicks Approve → sub goes `created → assigned` with same contributor.
2. **"Get help from someone else"** — assigned contributor opens parent → Add Sub-Contribution → picker is pre-filled → contributor changes it to a different community member → Submit → lead clicks Approve → sub goes `created → assigned` with the chosen contributor.
3. **Empty assignee path** — open Add Sub-Contribution → clear the picker → Submit blocked by `isValid`. (Optional: bypass via API to test backend rejection: backend returns 400 with "must have an assigned contributor".)
4. **Re-approval after lead edit** — on an `assigned` sub, lead clicks Edit, changes the title, saves → sub status becomes `changed` → Approve button reappears in both the dialog sub-list and the milestone collapsible card → click Approve → sub returns to `assigned`.

- [ ] **Step 4: Final commit if any small fixes were needed**

```bash
git status
# If clean, no commit needed.
# Otherwise: git add ... && git commit -m "fix: <whatever surfaced during e2e walk>"
```

---

## Self-Review Notes

- Spec coverage: every spec section maps to a task — backend approve gate (Task 2), backend create-with-assignee (Task 1), frontend create form picker (Tasks 5+6), workflow precondition (Task 4), Approve button disabled + tooltip + assignee display (Task 7).
- No placeholders. Every step has either exact code or a concrete command + expected output.
- Type consistency: `assigned_contributor_id` is the canonical field name across backend (Go), API client (TS), workflow composable, dialog form, and Approve guards. The Go field is `AssignedContributorID` mapped to JSON `assigned_contributor_id`. Frontend uses `assigned_contributor_id` everywhere.
- Risk noted in spec: Task 5's picker only renders when `parentContributionId && !editing` — top-level contributions are unaffected.
- Open implementation choice (resolved here): use `q-select` with `use-input` + `@filter` for the picker, sourced from `useProfilesStore.communityProfiles`. Lead-side change-assignee-before-approve uses the existing Edit button (no new "Change" affordance).
