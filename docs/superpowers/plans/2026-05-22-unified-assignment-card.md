# Unified Assignment Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct sub-contribution assignment with the existing offer/accept workflow, unify the assignment UI into a single `AssignmentCard` component used on every contribution surface, and fix the bug where unassign + re-offer leaves a stale `assigned_contributor` visible alongside the new offer.

**Architecture:**
- Backend: defensively clear `AssignedContributorID` in `OfferContribution`; replace `propagateAssigneeToChildren` with `propagateOfferToChildren` in all three parent-becomes-assigned paths (`AcceptOffer`, `AssignContributor`, `ConfirmContribution`).
- Frontend: new `AssignmentCard.vue` component handles the three card states (unassigned / offered / assigned) and is mounted in `ContributionDetailBody` (covers project detail dialog + standalone contributions page) and in `CreateContributionDialog` edit mode. The component owns its modal-picker (for new offers) and its inline-picker (for re-offer after unassign).
- The sub-contribution path stops calling `PUT /contributions/{id}` with `assigned_contributor_id`; everything goes through `POST /contributions/{id}/offer`.

**Tech Stack:** Go 1.22 (backend), Vue 3 / Quasar / Pinia / TypeScript (frontend), Playwright (e2e). No new dependencies.

---

## Spec reference

`docs/superpowers/specs/2026-05-22-unified-assignment-card-design.md` (commit `e7cb688`).

## File map

**Create**
- `frontend/src/components/contributions/AssignmentCard.vue` — single shared component.

**Modify (backend)**
- `backend/internal/contributions/service.go`:
  - `OfferContribution` (~line 1538): clear `AssignedContributorID`.
  - `propagateAssigneeToChildren` (~line 1409): rename to `propagateOfferToChildren` and rewrite body.
  - `AssignContributor` (~line 1450), `ConfirmContribution` (~line 1506), `AcceptOffer` (~line 1590): swap call to new function name.
  - Comment at line 1226 + 1795: update reference.
- `backend/internal/contributions/service_test.go`:
  - Update three existing propagation tests (lines 1534, 1650, 1698) to assert children are `offered` instead of inheriting via `AssignedContributorID`.
  - Add new test: `TestOfferContribution_ClearsAssignedContributorID`.
  - Add new tests: `TestPropagateOfferToChildren_SkipsAlreadyAssignedChild`, `TestPropagateOfferToChildren_SkipsAlreadyOfferedChild`.

**Modify (frontend)**
- `frontend/src/components/contributions/ContributionDetailBody.vue`:
  - Remove sub-assign-panel block (~lines 61–87).
  - Remove `offered-panel` block (~lines 89–99).
  - Remove the "Assign Contribution" button + its modal `<q-dialog>` block (lines ~850–857 and the whole `<q-dialog v-model="showAssignDialog">` block beginning ~line 922).
  - Remove `isSubAssignMode`, `openSubAssignDialog`, `submitSubAssign`, `openAssignDialog`, `submitAssign`, `selectAssignMember`, `assignMode`, `assignSelectedGroup`, `assignSelectedMember`, `assignSelectedMemberName`, `assigningContribution`, `showAssignDialog`, `canManageSubAssignment`, `canReassignContribution`.
  - Add a single `<AssignmentCard>` mount near the top of the body (where the sub-assign-panel sat) and forward its `@offered` / `@unassigned` events as `update`.
- `frontend/src/components/projects/CreateContributionDialog.vue`:
  - Remove `showReassignPicker` (~line 513) and the picker markup that uses it.
  - Remove `showUnassignBlock` (~line 524) and the unassign button block (~lines 302–315).
  - Remove `canUnassign` / `canReassign` props and the `unassign` emit (props at ~line 381, defaults at 396, emit at ~line 405).
  - Add `<AssignmentCard>` mount in edit mode, just above the Danger Zone block.
- `frontend/src/composables/useContributionWorkflow.ts`:
  - `canOffer`: drop top-level-only assumption (no change actually needed if it already doesn't gate on `parent_contribution`; verify and document).
  - Add `canUnassign` helper (mirror of existing inline checks).
- `frontend/src/pages/Projects/ProjectDetailPage.vue`:
  - Stop passing `:can-unassign` and `:can-reassign` to `<CreateContributionDialog>` (~line 551).
  - Remove `@unassign="onUnassignRequested"` and the `showUnassignConfirm` dialog block (~lines 567–578) — assignment management now happens inside the card itself.
  - Remove `doUnassign`, `onUnassignRequested`, `showUnassignConfirm`, `unassigning` refs (~lines 822, 916–935).

**Modify (e2e)**
- `frontend/tests/e2e/e2e-projects-contributions.spec.ts`: add a phase that offers a sub-contribution, has the recipient accept, then unassigns + re-offers and asserts no stale assignee text remains.

---

## Task 1: Backend — `OfferContribution` clears `AssignedContributorID`

**Files:**
- Modify: `backend/internal/contributions/service.go:1538-1557`
- Test: `backend/internal/contributions/service_test.go` (new test)

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/contributions/service_test.go`:

```go
func TestOfferContribution_ClearsAssignedContributorID(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	spaceID := "space-1"

	// Create + confirm a contribution.
	c, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID:          "proj-1",
		Title:              "task",
		Description:        "d",
		ContributionType:   ProposalTypeTechnical,
		Priority:           PriorityMedium,
		CreatedBy:          "lead-1",
		Objectives:         []string{"o"},
		Deliverables:       []string{"d"},
		AcceptanceCriteria: []string{"a"},
	})
	if err != nil {
		t.Fatalf("CreateContribution: %v", err)
	}
	if _, err := svc.ConfirmContribution(ctx, spaceID, c.ID); err != nil {
		t.Fatalf("ConfirmContribution: %v", err)
	}

	// Force a stale AssignedContributorID into the stored contribution.
	c.AssignedContributorID = "stale-user"
	if err := svc.SaveContribution(ctx, spaceID, c); err != nil {
		t.Fatalf("SaveContribution: %v", err)
	}

	// Offer should clear it.
	out, err := svc.OfferContribution(ctx, spaceID, c.ID, "new-user", "New User")
	if err != nil {
		t.Fatalf("OfferContribution: %v", err)
	}
	if out.AssignedContributorID != "" {
		t.Errorf("AssignedContributorID = %q, want empty", out.AssignedContributorID)
	}
	if out.OfferedTo != "new-user" {
		t.Errorf("OfferedTo = %q, want new-user", out.OfferedTo)
	}
	if out.Status != ContribOffered {
		t.Errorf("Status = %s, want offered", out.Status)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```
cd backend && go test ./internal/contributions/ -run TestOfferContribution_ClearsAssignedContributorID -v
```

Expected: FAIL with `AssignedContributorID = "stale-user", want empty`.

- [ ] **Step 3: Implement the fix in `OfferContribution`**

In `backend/internal/contributions/service.go`, locate the body of `OfferContribution` (~line 1546) and add the clear:

```go
	now := time.Now()
	c.AssignedContributorID = ""
	c.OfferedTo = offeredTo
	c.OfferedToName = offeredToName
	c.OfferedAt = &now
	c.AssignedContributorName = offeredToName
	c.Status = ContribOffered
	c.UpdatedAt = now
```

- [ ] **Step 4: Run all contributions tests**

```
cd backend && go test ./internal/contributions/ -v
```

Expected: PASS (including the new test). Existing `TestUnassignContribution_*` tests should still pass — they don't depend on this change.

- [ ] **Step 5: Commit**

```
git add backend/internal/contributions/service.go backend/internal/contributions/service_test.go
git commit -m "fix(contributions): clear assigned id when offering to prevent stale assignee" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend — replace propagation with `propagateOfferToChildren`

**Files:**
- Modify: `backend/internal/contributions/service.go:1409-1434, 1450, 1506, 1590`
- Modify: `backend/internal/contributions/service_test.go:1534, 1650, 1698` (three existing tests need their expected end-state updated)
- Test: `backend/internal/contributions/service_test.go` (two new tests)

- [ ] **Step 1: Update the three existing propagation tests**

These currently assert child `AssignedContributorID == parent.Contributor`. After the change, children are offered instead. Update each test's final assertions:

In `TestAssignContributor_PropagatesAssigneeToCreatedChildren` (~line 1534), replace the assertion block at the end of the test:

```go
	// The child should now be offered to "user-A" and in ContribOffered status.
	reloaded, err := svc.GetContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("reload child: %v", err)
	}
	if reloaded.OfferedTo != "user-A" {
		t.Errorf("expected OfferedTo=user-A, got %q", reloaded.OfferedTo)
	}
	if reloaded.AssignedContributorID != "" {
		t.Errorf("expected AssignedContributorID empty, got %q", reloaded.AssignedContributorID)
	}
	if reloaded.Status != ContribOffered {
		t.Errorf("expected status offered, got %s", reloaded.Status)
	}
```

Apply the same updated assertions to `TestAcceptOffer_PropagatesAssigneeToCreatedChildren` (~line 1650) and `TestConfirmContribution_PropagatesAssigneeOnChangedToAssigned` (~line 1698) — same expected end state (child offered to parent's assignee, not directly assigned).

- [ ] **Step 2: Add two new propagation tests**

Append to `service_test.go`:

```go
func TestPropagateOfferToChildren_SkipsAlreadyAssignedChild(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	spaceID := "space-1"

	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: "proj-1", Title: "parent", Description: "d",
		ContributionType: ProposalTypeTechnical, Priority: PriorityMedium, CreatedBy: "lead-1",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	if _, err := svc.ConfirmContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("confirm parent: %v", err)
	}

	// Child already assigned to someone else; force the state.
	child := createUnassignedChild(t, svc, ctx, spaceID, parent.ID)
	child.Status = ContribAssigned
	child.AssignedContributorID = "other-user"
	if err := svc.SaveContribution(ctx, spaceID, child); err != nil {
		t.Fatalf("save child: %v", err)
	}

	// Offer + accept parent.
	if _, err := svc.OfferContribution(ctx, spaceID, parent.ID, "parent-user", "Parent User"); err != nil {
		t.Fatalf("offer parent: %v", err)
	}
	if _, err := svc.AcceptOffer(ctx, spaceID, parent.ID, "parent-user"); err != nil {
		t.Fatalf("accept parent: %v", err)
	}

	// Child should still be assigned to other-user, untouched.
	got, err := svc.GetContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("reload child: %v", err)
	}
	if got.AssignedContributorID != "other-user" {
		t.Errorf("AssignedContributorID = %q, want other-user", got.AssignedContributorID)
	}
	if got.OfferedTo != "" {
		t.Errorf("OfferedTo = %q, want empty", got.OfferedTo)
	}
	if got.Status != ContribAssigned {
		t.Errorf("Status = %s, want assigned", got.Status)
	}
}

func TestPropagateOfferToChildren_SkipsAlreadyOfferedChild(t *testing.T) {
	svc := NewService(NewMockStore())
	ctx := context.Background()
	spaceID := "space-1"

	parent, err := svc.CreateContribution(ctx, spaceID, &CreateContributionRequest{
		ProjectID: "proj-1", Title: "parent", Description: "d",
		ContributionType: ProposalTypeTechnical, Priority: PriorityMedium, CreatedBy: "lead-1",
		Objectives: []string{"o"}, Deliverables: []string{"d"}, AcceptanceCriteria: []string{"a"},
	})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	if _, err := svc.ConfirmContribution(ctx, spaceID, parent.ID); err != nil {
		t.Fatalf("confirm parent: %v", err)
	}

	child := createUnassignedChild(t, svc, ctx, spaceID, parent.ID)
	if _, err := svc.ConfirmContribution(ctx, spaceID, child.ID); err != nil {
		t.Fatalf("confirm child: %v", err)
	}
	if _, err := svc.OfferContribution(ctx, spaceID, child.ID, "early-offer-user", "Early Offer"); err != nil {
		t.Fatalf("offer child: %v", err)
	}

	if _, err := svc.OfferContribution(ctx, spaceID, parent.ID, "parent-user", "Parent User"); err != nil {
		t.Fatalf("offer parent: %v", err)
	}
	if _, err := svc.AcceptOffer(ctx, spaceID, parent.ID, "parent-user"); err != nil {
		t.Fatalf("accept parent: %v", err)
	}

	got, err := svc.GetContribution(ctx, spaceID, child.ID)
	if err != nil {
		t.Fatalf("reload child: %v", err)
	}
	if got.OfferedTo != "early-offer-user" {
		t.Errorf("OfferedTo = %q, want early-offer-user", got.OfferedTo)
	}
}
```

- [ ] **Step 3: Run the propagation tests to confirm they fail**

```
cd backend && go test ./internal/contributions/ -run "Propagate|TestAssignContributor_Propagates|TestAcceptOffer_Propagates|TestConfirmContribution_Propagates" -v
```

Expected: all of these FAIL — children inherit `AssignedContributorID` from parent in the current code, not `OfferedTo`.

- [ ] **Step 4: Rename + rewrite the propagation function**

In `backend/internal/contributions/service.go`, replace `propagateAssigneeToChildren` (around line 1409–1434) with:

```go
// propagateOfferToChildren walks the parent's ChildContributionIDs and, for each
// child that is still in created/confirmed status with no assignee or pending offer,
// offers the child to the parent's accepted contributor. Children already assigned,
// already offered, or in any later lifecycle stage are left untouched.
//
// Children in ContribCreated are confirmed first so they satisfy OfferContribution's
// status guard. Load failures are logged and skipped (best-effort); save and offer
// failures abort.
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

- [ ] **Step 5: Update the three callers**

In the same file, find each call to `s.propagateAssigneeToChildren(ctx, spaceID, c)` (lines ~1450, ~1506, ~1590) and rename to `s.propagateOfferToChildren(ctx, spaceID, c)`. The signatures are identical.

Also update the two comments that reference the old name:
- Line ~1226: "Mirrors the propagateAssigneeToChildren path that" → "Mirrors the propagateOfferToChildren path that"
- Line ~1795: "later inherit the parent's assignee (via propagateAssigneeToChildren) or be assigned" → "later be offered to the parent's contributor (via propagateOfferToChildren) or be assigned"

- [ ] **Step 6: Run all contributions tests**

```
cd backend && go test ./internal/contributions/ -v
```

Expected: PASS. All five propagation tests (three existing + two new) and the unrelated suite pass.

- [ ] **Step 7: Commit**

```
git add backend/internal/contributions/service.go backend/internal/contributions/service_test.go
git commit -m "feat(contributions): propagate offers (not direct-assign) to sub-contributions" -m "Parent acceptance now offers each unassigned child to the parent's contributor instead of directly assigning. Each child becomes its own offer the contributor can accept or decline independently." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Backend — run the full backend test suite

**Files:** none (verification only)

- [ ] **Step 1: Run the whole contributions package**

```
cd backend && go test ./internal/contributions/... -v
```

Expected: every test PASSES.

- [ ] **Step 2: Run the broader backend test suite (sanity)**

```
cd backend && make test
```

Expected: every package passes. No new failures relative to `main`.

- [ ] **Step 3: Lint + vet**

```
cd backend && make lint
```

Expected: clean.

---

## Task 4: Frontend — create `AssignmentCard.vue`

**Files:**
- Create: `frontend/src/components/contributions/AssignmentCard.vue`

- [ ] **Step 1: Create the component file**

Write the new file with this exact content:

```vue
<template>
  <div class="assignment-card" :class="`state-${state}`">
    <!-- Unassigned state -->
    <div v-if="state === 'unassigned'" class="row-between">
      <div>
        <div class="card-title">No contributor assigned</div>
        <div class="card-sub">Offer this contribution to a member.</div>
      </div>
      <q-btn
        v-if="canOffer"
        no-caps
        unelevated
        color="primary"
        icon="person_add"
        label="Assign"
        @click="showAssignModal = true"
      />
    </div>

    <!-- Offered state -->
    <div v-else-if="state === 'offered'" class="row-between">
      <div>
        <div class="card-title">
          Offered to {{ recipientName }} — awaiting acceptance
        </div>
        <div v-if="contribution.offered_at" class="card-sub">
          Offered {{ formatDate(contribution.offered_at) }}
        </div>
      </div>
      <q-btn
        v-if="canOffer"
        no-caps
        flat
        color="primary"
        label="Re-offer"
        @click="showAssignModal = true"
      />
    </div>

    <!-- Assigned state (and inline re-offer mode after unassign) -->
    <div v-else-if="state === 'assigned'">
      <div class="row-between">
        <div>
          <div class="card-title">Assigned to {{ assignedName }}</div>
        </div>
        <q-btn
          v-if="canUnassign && !showInlinePicker"
          no-caps
          outline
          color="negative"
          icon="person_remove"
          label="Unassign"
          :loading="unassigning"
          @click="handleUnassign"
        />
      </div>

      <div v-if="showInlinePicker" class="inline-picker q-mt-md">
        <div class="label">Offer to a member</div>
        <MemberPicker
          v-model="inlineSelectedId"
          :members="pickerMembers"
          placeholder="Search members..."
          @select="onInlineMemberSelected"
        />
        <div class="row q-mt-sm">
          <q-btn
            no-caps
            flat
            label="Cancel"
            @click="closeInlinePicker"
          />
        </div>
      </div>
    </div>

    <!-- Terminal-status read-only view -->
    <div v-else-if="state === 'readonly'" class="row-between">
      <div>
        <div class="card-title">
          {{ assignedName ? `Was assigned to ${assignedName}` : 'No contributor' }}
        </div>
      </div>
    </div>

    <!-- Modal picker (used by Assign + Re-offer) -->
    <q-dialog v-model="showAssignModal">
      <q-card class="assignment-modal">
        <q-card-section class="row items-center">
          <div class="text-h6">{{ state === 'offered' ? 'Re-offer Contribution' : 'Assign Contribution' }}</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>
        <q-card-section>
          <MemberPicker
            v-model="modalSelectedId"
            :members="pickerMembers"
            placeholder="Search members..."
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn no-caps flat label="Cancel" v-close-popup />
          <q-btn
            no-caps
            unelevated
            color="primary"
            label="Send Offer"
            :disable="!modalSelectedId"
            :loading="offering"
            @click="submitModalOffer"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useQuasar } from 'quasar';
import { useProfilesStore } from 'stores/profiles';
import { useContributionsStore } from 'stores/contributions';
import MemberPicker, { type MemberOption } from 'src/components/common/MemberPicker.vue';
import type { Contribution } from 'src/types/projects';

interface Props {
  contribution: Contribution;
  canOffer: boolean;
  canUnassign: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'offered', updated: Contribution): void;
  (e: 'unassigned', updated: Contribution): void;
}>();

const $q = useQuasar();
const profilesStore = useProfilesStore();
const store = useContributionsStore();

const showAssignModal = ref(false);
const modalSelectedId = ref('');
const showInlinePicker = ref(false);
const inlineSelectedId = ref('');
const offering = ref(false);
const unassigning = ref(false);

const assignedAid = computed(() =>
  props.contribution.assigned_contributor_id ?? props.contribution.assigned_contributor ?? '',
);

const assignedName = computed(() => {
  if (!assignedAid.value) return '';
  const profile = profilesStore.profilesByAid[assignedAid.value];
  return profile?.displayName
    ?? props.contribution.assigned_contributor_name
    ?? assignedAid.value.slice(0, 12) + '...';
});

const recipientName = computed(() => {
  const aid = props.contribution.offered_to;
  if (!aid) return '';
  const profile = profilesStore.profilesByAid[aid];
  return profile?.displayName
    ?? props.contribution.offered_to_name
    ?? aid.slice(0, 12) + '...';
});

const TERMINAL_STATUSES = ['changed', 'needs_review', 'incomplete', 'approved', 'signed_off', 'rewarded', 'declined', 'archived'];

const state = computed<'unassigned' | 'offered' | 'assigned' | 'readonly' | 'hidden'>(() => {
  const s = props.contribution.status;
  if (s === 'created') return 'hidden';
  if (TERMINAL_STATUSES.includes(s)) {
    return assignedAid.value || props.contribution.assigned_contributor_name ? 'readonly' : 'hidden';
  }
  if (s === 'offered') return 'offered';
  if (s === 'assigned') return 'assigned';
  return 'unassigned';
});

const pickerMembers = computed<MemberOption[]>(() => {
  // Drop removed/pending members the same way other pickers do.
  const all = Object.values(profilesStore.profilesByAid).filter(p =>
    p && p.status !== 'removed' && p.status !== 'pending',
  );
  return all.map(p => ({ id: p.aid, name: p.displayName || p.aid.slice(0, 12) + '...' }));
});

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

async function submitModalOffer() {
  if (!modalSelectedId.value) return;
  const picked = pickerMembers.value.find(m => m.id === modalSelectedId.value);
  offering.value = true;
  try {
    const updated = await store.offer(props.contribution.id, {
      offered_to: modalSelectedId.value,
      offered_to_name: picked?.name ?? modalSelectedId.value,
    });
    $q.notify({ type: 'positive', message: 'Offer sent.' });
    showAssignModal.value = false;
    modalSelectedId.value = '';
    emit('offered', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to offer' });
  } finally {
    offering.value = false;
  }
}

async function handleUnassign() {
  unassigning.value = true;
  try {
    const updated = await store.unassign(props.contribution.id);
    $q.notify({ type: 'positive', message: 'Contributor unassigned.' });
    showInlinePicker.value = true;
    emit('unassigned', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to unassign' });
  } finally {
    unassigning.value = false;
  }
}

async function onInlineMemberSelected(member: MemberOption) {
  inlineSelectedId.value = member.id;
  offering.value = true;
  try {
    const updated = await store.offer(props.contribution.id, {
      offered_to: member.id,
      offered_to_name: member.name,
    });
    $q.notify({ type: 'positive', message: 'Offer sent.' });
    showInlinePicker.value = false;
    inlineSelectedId.value = '';
    emit('offered', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to offer' });
  } finally {
    offering.value = false;
  }
}

function closeInlinePicker() {
  showInlinePicker.value = false;
  inlineSelectedId.value = '';
}
</script>

<style scoped lang="scss">
.assignment-card {
  padding: 12px;
  border: 1px solid var(--matou-border);
  border-radius: 8px;
  background: var(--matou-secondary);
  margin: 12px 0;
}

.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-title {
  font-weight: 600;
  color: var(--matou-foreground);
}

.card-sub {
  font-size: 0.85rem;
  color: var(--matou-muted-foreground);
  margin-top: 2px;
}

.label {
  text-transform: uppercase;
  font-size: 0.75rem;
  letter-spacing: 0.05em;
  color: var(--matou-muted-foreground);
  margin-bottom: 6px;
}

.assignment-modal {
  min-width: 360px;
}

.state-hidden {
  display: none;
}
</style>
```

- [ ] **Step 2: Lint the new file**

```
cd frontend && npx eslint src/components/contributions/AssignmentCard.vue
```

Expected: no errors.

- [ ] **Step 3: Type-check**

```
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "AssignmentCard"
```

Expected: no errors mentioning `AssignmentCard.vue`. (Pre-existing errors in unrelated files are fine.)

- [ ] **Step 4: Commit**

```
git add frontend/src/components/contributions/AssignmentCard.vue
git commit -m "feat(contributions): add shared AssignmentCard component" -m "Single component owns the unassigned/offered/assigned states for any contribution. Unassigned + offered open a modal picker. Assigned reveals an inline picker after unassign so re-offer is one click away." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend — mount `AssignmentCard` in `ContributionDetailBody.vue`

**Files:**
- Modify: `frontend/src/components/contributions/ContributionDetailBody.vue` (sections at ~lines 61-87, 89-99, 850-857, 922-?, plus script-section refs/functions/computeds at 1171, 1377-1474, 1551-1632)

This task is large; do the deletions before the addition so the file stays compilable at every checkpoint.

- [ ] **Step 1: Import the new component**

In `ContributionDetailBody.vue`, locate the import block in `<script setup>` and add:

```ts
import AssignmentCard from 'src/components/contributions/AssignmentCard.vue';
```

- [ ] **Step 2: Replace the sub-assign-panel and Offered panel with `<AssignmentCard>`**

Delete the entire block from `<!-- Sub-contribution assignment panel (leads/admins on active subs) -->` through the closing `</div>` of the `offered-panel` (template lines ~61–99 inclusive). Replace with:

```vue
        <!-- Unified assignment card -->
        <AssignmentCard
          :contribution="contribution"
          :can-offer="canOfferNow"
          :can-unassign="canUnassignNow"
          @offered="(c) => emit('update', c)"
          @unassigned="(c) => emit('update', c)"
        />
```

- [ ] **Step 3: Remove the "Assign Contribution" button at the bottom**

Find the block starting `<q-btn v-if="canShareNow || canOfferNow" ... label="Assign Contribution" ...>` (~lines 850–857) and delete the entire `<q-btn>` element.

- [ ] **Step 4: Remove the Assign Contribution modal dialog**

Find the block `<!-- Assign contribution dialog -->\n<q-dialog v-model="showAssignDialog">` (~line 922) and delete the entire `<q-dialog>...</q-dialog>` element. The modal is now owned by `AssignmentCard`.

- [ ] **Step 5: Delete the now-unused script refs and helpers**

In `<script setup>`, delete these declarations and their initial values:

```ts
const isSubAssignMode = ref(false);
const showAssignDialog = ref(false);
const assignMode = ref<'group' | 'member' | null>(null);
const assignSelectedGroup = ref<string | null>(null);
const assignSelectedMember = ref<string | null>(null);
const assignSelectedMemberName = ref<string | null>(null);
const assigningContribution = ref(false);
```

And these functions/computeds:

- `function openAssignDialog()`
- `function openSubAssignDialog()`
- `function selectAssignMember(...)`
- `async function submitSubAssign()`
- `async function submitAssign()`
- `const canManageSubAssignment = computed(...)`
- `const canReassignContribution = computed(...)`

- [ ] **Step 6: Add `canUnassignNow` computed**

Replace the deleted `canReassignContribution` with:

```ts
const canUnassignNow = computed(() => {
  if (!(isLead.value || isSteward.value)) return false;
  return props.contribution.status === 'assigned';
});
```

The existing `canOfferNow` is reused as-is.

- [ ] **Step 7: Lint + type-check**

```
cd frontend && npx eslint src/components/contributions/ContributionDetailBody.vue
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "ContributionDetailBody"
```

Expected: no new errors.

- [ ] **Step 8: Smoke-test in dev**

Start dev session 1 if not already running (`npm run dev:sessions:2` from frontend/). In the running app at http://localhost:5100:

1. Log in as community admin.
2. Open any project that has a contribution in `confirmed` state. Confirm the AssignmentCard renders "No contributor assigned" with an "Assign" button.
3. Click Assign → modal opens with the member picker → select a member → "Send Offer". Confirm status flips to `offered` and the card shows "Offered to X".
4. Click Re-offer → modal opens; pick a different member; confirm the recipient updates.
5. Have the offered-to user accept the offer (or impersonate in session 2). Confirm card flips to "Assigned to X" with an Unassign button.
6. Click Unassign → inline search list appears in the card. Pick another member. Card flips to "Offered to {new}".
7. **Crucially:** confirm there is NO "Assigned to {original}" text remaining anywhere on the contribution page.

If anything is off, fix before committing.

- [ ] **Step 9: Commit**

```
git add frontend/src/components/contributions/ContributionDetailBody.vue
git commit -m "refactor(contributions): use shared AssignmentCard in detail body" -m "Drops the sub-assign-panel, Offered panel, and bottom Assign button in favour of a single card that handles every assignment state for both top-level and sub-contributions." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Frontend — mount `AssignmentCard` in `CreateContributionDialog.vue` (edit mode)

**Files:**
- Modify: `frontend/src/components/projects/CreateContributionDialog.vue` (sections at ~lines 280-315, 381, 396, 405, 510-532)

- [ ] **Step 1: Import the component**

In `<script setup>` of `CreateContributionDialog.vue`, add:

```ts
import AssignmentCard from 'src/components/contributions/AssignmentCard.vue';
```

- [ ] **Step 2: Remove the unassign button block**

Delete the entire `<div v-if="showUnassignBlock" class="unassign-block q-mt-sm">...</div>` block at ~lines 303–315.

- [ ] **Step 3: Remove `showReassignPicker` markup**

In the template, search for any `<MemberPicker>` or picker markup gated by `showReassignPicker`. Delete the picker block. (Keep the form-level `assigned_contributor_id` field used during sub-create; that's only used in create mode.)

- [ ] **Step 4: Insert `<AssignmentCard>` in edit mode**

Place this just before the Danger Zone block (`<div v-if="editing && canDelete" class="danger-zone q-mt-md">`):

```vue
        <AssignmentCard
          v-if="editing && contribution"
          :contribution="contribution"
          :can-offer="canOffer"
          :can-unassign="canUnassign"
          @offered="onAssignmentChanged"
          @unassigned="onAssignmentChanged"
        />
```

Note: keep the existing `canOffer` and `canUnassign` props (the parent computes them); we'll narrow the props later in step 6.

- [ ] **Step 5: Remove unused script declarations**

Delete:
- `const showReassignPicker = computed(() => { ... })` (~lines 510–522).
- `const showUnassignBlock = computed(() => { ... })` (~lines 524–532).
- The `(e: 'unassign'): void` entry from the emits.
- The `canUnassign?` and `canReassign?` props from the `Props` interface and `withDefaults` (~lines 381 and 396).

- [ ] **Step 6: Add `canOffer` and `canUnassign` props**

Replace the removed `canUnassign` / `canReassign` props with:

```ts
interface Props {
  // ... existing props
  canOffer?: boolean;
  canUnassign?: boolean;
}
```

And add the defaults in `withDefaults`:
```ts
  canOffer: false,
  canUnassign: false,
```

- [ ] **Step 7: Add an `onAssignmentChanged` handler that forwards updates**

In the script:

```ts
function onAssignmentChanged(updated: Contribution) {
  emit('update', updated);
}
```

Add `(e: 'update', contribution: Contribution): void;` to the `defineEmits` declaration if it isn't already there.

- [ ] **Step 8: Lint + type-check**

```
cd frontend && npx eslint src/components/projects/CreateContributionDialog.vue
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "CreateContributionDialog"
```

Expected: no new errors.

- [ ] **Step 9: Commit**

```
git add frontend/src/components/projects/CreateContributionDialog.vue
git commit -m "refactor(contributions): use AssignmentCard in edit dialog" -m "Replaces the dialog's reassign-picker and unassign block with the shared AssignmentCard so editing a contribution surfaces the same assignment controls as the detail body." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Frontend — drop unassign wiring from `ProjectDetailPage.vue`

**Files:**
- Modify: `frontend/src/pages/Projects/ProjectDetailPage.vue` (~lines 551, 554, 567-578, 822, 916-935)

- [ ] **Step 1: Remove the `@unassign` listener and `:can-unassign` prop from the dialog mount**

In the `<CreateContributionDialog ...>` mount (~line 551), delete the lines:

```vue
      :can-unassign="perms.canAssignRoles.value || perms.isLead.value || perms.isSteward.value"
      @unassign="onUnassignRequested"
```

Add (or keep) the new prop wiring:

```vue
      :can-offer="perms.isLead.value || perms.isSteward.value"
      :can-unassign="perms.isLead.value || perms.isSteward.value"
```

- [ ] **Step 2: Delete the Unassign confirm dialog**

Find the block `<!-- Unassign contributor confirm -->\n<ConfirmDialog v-model="showUnassignConfirm" ...>` (~lines 567–578). Delete the entire `<ConfirmDialog>` element.

- [ ] **Step 3: Delete the now-unused script declarations**

In `<script setup>`, delete:

- `const showUnassignConfirm = ref(false);` (~line 822)
- `const unassigning = ref(false);` (search for it; near the same area)
- `function onUnassignRequested() { ... }` (~line 916)
- `async function doUnassign() { ... }` (~line 920)

- [ ] **Step 4: Lint + type-check**

```
cd frontend && npx eslint src/pages/Projects/ProjectDetailPage.vue
cd frontend && npx vue-tsc --noEmit 2>&1 | grep "ProjectDetailPage"
```

Expected: no new errors.

- [ ] **Step 5: Smoke-test the edit-dialog path**

In the running dev app:
1. Open a project, expand any assigned top-level contribution, click Edit.
2. Confirm the edit dialog shows the AssignmentCard "Assigned to X" with Unassign.
3. Click Unassign in the card → inline picker → pick a new member → confirm Offered state.
4. Close the dialog without saving; the contribution should still be in Offered state (the card's actions persist independently of the dialog's Save).

- [ ] **Step 6: Commit**

```
git add frontend/src/pages/Projects/ProjectDetailPage.vue
git commit -m "refactor(contributions): drop ProjectDetailPage unassign confirm flow" -m "AssignmentCard owns unassign + re-offer end-to-end. The dialog-level confirmation step and its separate Unassign button are no longer needed." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Frontend — verify standalone `ContributionDetailPage.vue` inherits the new card

**Files:**
- Verify only: `frontend/src/pages/Contributions/ContributionDetailPage.vue` (mounts `ContributionDetailBody`)

- [ ] **Step 1: Read the page and confirm it just mounts `ContributionDetailBody`**

```
grep -n "ContributionDetailBody\|AssignmentCard" frontend/src/pages/Contributions/ContributionDetailPage.vue
```

Expected: `ContributionDetailBody` is mounted; no direct reference to `AssignmentCard` needed since the body owns the card.

- [ ] **Step 2: Smoke-test the standalone page**

In the dev app, navigate directly to `/contributions/<id>` for an assigned contribution. Confirm the AssignmentCard is visible with the same behavior as the project-page dialog.

If a navigation entry to this route doesn't exist, paste the URL directly into the browser. Use any contribution id from `curl http://127.0.0.1:4000/api/v1/projects/<proj_id>/contributions | jq -r '.contributions[0].id'`.

- [ ] **Step 3: No commit (verification-only task)**

---

## Task 9: E2E — extend `e2e-projects-contributions.spec.ts`

**Files:**
- Modify: `frontend/tests/e2e/e2e-projects-contributions.spec.ts`

- [ ] **Step 1: Add a new phase covering sub-contribution offer/accept**

Append a new test inside the existing `test.describe` block. The test mirrors the existing Phase 2.5 sub-contribution test but exercises the new offer flow instead of direct assign:

```ts
test('Phase 5: sub-contribution flows through offer/accept', async () => {
  // Login as admin
  await loginAs(page, ADMIN_AID);

  // Open the test project's contribution list, find an assigned top-level contribution
  await page.goto('/projects');
  await page.click(`text=${TEST_PROJECT_TITLE}`);
  await page.waitForSelector('.contribution-card', { timeout: 30_000 });

  // Open the contribution that has children
  await page.click(`.contribution-card:has-text("${PARENT_CONTRIB_TITLE}")`);

  // Find a sub-contribution that has no assignee
  const subRow = page.locator('.sub-contribution-row', { hasText: SUB_TITLE });
  await subRow.click();

  // The AssignmentCard should be visible with "No contributor assigned"
  await expect(page.locator('.assignment-card')).toContainText('No contributor assigned');

  // Click Assign → modal opens
  await page.click('.assignment-card .q-btn:has-text("Assign")');
  await page.click(`.q-dialog .member-picker-row:has-text("${MEMBER_NAME}")`);
  await page.click('.q-dialog .q-btn:has-text("Send Offer")');

  // Card should now show Offered state
  await expect(page.locator('.assignment-card')).toContainText(`Offered to ${MEMBER_NAME}`);

  // Switch user, accept the offer
  await loginAs(page, MEMBER_AID);
  await page.goto('/contributions');
  await page.click(`text=${SUB_TITLE}`);
  await page.click('.q-btn:has-text("Accept Offer")');

  // Status should now be assigned
  await expect(page.locator('.assignment-card')).toContainText(`Assigned to ${MEMBER_NAME}`);
});

test('Phase 6: unassign + re-offer clears stale assignee', async () => {
  await loginAs(page, ADMIN_AID);
  await page.goto('/projects');
  await page.click(`text=${TEST_PROJECT_TITLE}`);
  await page.click(`.contribution-card:has-text("${ASSIGNED_CONTRIB_TITLE}")`);

  // Should currently be assigned to MEMBER_A
  await expect(page.locator('.assignment-card')).toContainText(`Assigned to ${MEMBER_A_NAME}`);

  // Unassign — inline picker reveals
  await page.click('.assignment-card .q-btn:has-text("Unassign")');
  await expect(page.locator('.assignment-card .inline-picker')).toBeVisible();

  // Pick MEMBER_B — auto-offers
  await page.click(`.assignment-card .member-picker-row:has-text("${MEMBER_B_NAME}")`);

  // Card should show Offered to MEMBER_B and NOT show "Assigned to MEMBER_A"
  await expect(page.locator('.assignment-card')).toContainText(`Offered to ${MEMBER_B_NAME}`);
  await expect(page.locator('.assignment-card')).not.toContainText(`Assigned to ${MEMBER_A_NAME}`);
  // Also assert there's no avatar tooltip leaking the old assignee
  await expect(page.locator('.assigned-avatar')).toHaveCount(0);
});
```

Replace the placeholders (`TEST_PROJECT_TITLE`, `PARENT_CONTRIB_TITLE`, `SUB_TITLE`, `MEMBER_NAME`, `MEMBER_AID`, `ADMIN_AID`, `MEMBER_A_NAME`, `MEMBER_B_NAME`, `ASSIGNED_CONTRIB_TITLE`) with the constants used by the existing tests in this file. Read the top of the file to find the right names.

- [ ] **Step 2: Run the e2e suite**

```
cd frontend && npm run test -- --project=contributions
```

Expected: PASS (including the two new phases). If the e2e infra needs a fresh clean-start first (see CLAUDE.md memory: stale KERIA notifications), run `cd ../matou-infrastructure/keri && make clean-test && make up-test` and `cd matou-app && ./scripts/clean-test.sh` first.

- [ ] **Step 3: Commit**

```
git add frontend/tests/e2e/e2e-projects-contributions.spec.ts
git commit -m "test(e2e): sub-contribution offer/accept + unassign re-offer no-stale-state" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run all backend tests**

```
cd backend && go test ./... -count=1
```

Expected: PASS.

- [ ] **Step 2: Run frontend lint**

```
cd frontend && npm run lint
```

Expected: PASS (or only pre-existing warnings unrelated to this work).

- [ ] **Step 3: Type-check**

```
cd frontend && npx vue-tsc --noEmit
```

Expected: no new errors. (Pre-existing errors in unrelated files are acceptable.)

- [ ] **Step 4: Manual end-to-end smoke**

In the dev app (http://localhost:5100):
1. Top-level contribution: offer → accept → unassign → re-offer to different member. Confirm no stale assignee text at any point.
2. Sub-contribution: parent accepted → child auto-offered → child contributor accepts → card transitions through all three states.
3. Edit dialog: open an assigned contribution, confirm AssignmentCard renders with Unassign. Use inline re-offer; close dialog without saving; confirm contribution is now in offered state.

- [ ] **Step 5: Bump version**

In `frontend/package.json`, bump `version` to the next patch (e.g. `0.2.4` → `0.2.5`).

```
git add frontend/package.json
git commit -m "chore: bump version to 0.2.5"
```
