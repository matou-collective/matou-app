# Contributions UI Gaps Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the UI gaps between the Figma design reference components and the current Vue/Quasar implementation for the projects & contributions system.

**Architecture:** Each task targets one component or page. Changes are additive — no existing functionality is removed. The design reference uses React/Shadcn; we translate to Vue 3 Composition API + Quasar components while preserving the same visual layout, data flow, and conditional logic. The existing `useContributionWorkflow` composable and Pinia stores are reused. Types (`Contribution`, `AttachedFile`, `SubmitEvidenceRequest`) already exist in `frontend/src/types/projects.ts` and include all needed fields.

**Tech Stack:** Vue 3, Quasar Framework, TypeScript, Pinia, SCSS

**Gaps addressed (by priority):**
- Gap 3: ContributionDetailDialog — per-criterion acceptance responses, file uploads, recursive child dialog
- Gap 9: Sub-contributions — clickable child items opening nested dialog, blocking warning with names
- Gap 7: Evidence — file upload zones (time report + attachments)
- Gap 2: ContributionCardCompact — description, hours, ID, Share/Offer quick actions, sub-contribution preview
- Gap 4: MilestoneCard — per-milestone progress bar, contribution count
- Gap 10: ContributionDetailPage — evidence URLs in evidence dialog
- Gap 8: Review stars — replace q-slider with 10-star click interface on ContributionDetailPage

**Note on existing types:** `Contribution` in `frontend/src/types/projects.ts` already has `acceptance_notes`, `time_report_file`, `attachment_files`, and `evidence_urls` fields. `SubmitEvidenceRequest` already accepts all these fields. `AttachedFile` interface (`{ name, url, type }`) is defined there too. No type changes are needed.

**Note on `evidenceForm`:** In `ContributionDetailDialog.vue`, `evidenceForm` uses `ref()` (not `reactive()`). Template access is direct (`evidenceForm.field`), but script-side access requires `.value` (e.g., `evidenceForm.value.completion_notes`).

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `frontend/src/components/projects/ContributionDetailDialog.vue` | Modify | Add per-criterion evidence, file uploads, recursive child dialog, blocking child names |
| `frontend/src/components/projects/ContributionCardCompact.vue` | Modify | Add description, hours, ID, Share/Offer actions, sub-contribution preview |
| `frontend/src/components/projects/MilestoneCard.vue` | Modify | Add progress bar, contribution count; wire new compact card emits |
| `frontend/src/pages/Contributions/ContributionDetailPage.vue` | Modify | Add evidence URLs to dialog, replace slider with stars |

---

## Chunk 1: ContributionDetailDialog Evidence, File Uploads & Recursive Child

### Task 1: Add per-criterion acceptance responses to ContributionDetailDialog evidence form

**Files:**
- Modify: `frontend/src/components/projects/ContributionDetailDialog.vue`

- [ ] **Step 1: Add acceptance_notes to the evidenceForm ref**

In the `<script setup>` section, find the `evidenceForm` ref (line 630). Add `acceptance_notes`:

```typescript
const evidenceForm = ref({
  completion_notes: '',
  evidence_urls: [''],
  actual_duration: undefined as number | undefined,
  acceptance_notes: [] as string[],  // NEW: per-criterion responses
});
```

- [ ] **Step 2: Initialize acceptance_notes from contribution's acceptance_criteria**

Add a watcher that initializes `acceptance_notes` with empty strings matching the length of `contribution.acceptance_criteria`:

```typescript
watch(() => props.contribution.acceptance_criteria, (criteria) => {
  if (criteria?.length && evidenceForm.value.acceptance_notes.length === 0) {
    evidenceForm.value.acceptance_notes = criteria.map(() => '');
  }
}, { immediate: true });
```

- [ ] **Step 3: Add the per-criterion UI to the evidence form template**

In the template, find the evidence submission section (line 248, `v-if="canSubmitEvidenceNow"`). After the completion notes textarea (line 254–261) and before the evidence URLs section (line 263), add:

```html
<!-- Per-criterion acceptance responses -->
<div v-if="contribution.acceptance_criteria?.length" class="evidence-criteria">
  <div class="section-label">Acceptance Criteria Responses</div>
  <div
    v-for="(criterion, idx) in contribution.acceptance_criteria"
    :key="idx"
    class="criterion-response"
  >
    <div class="criterion-text">
      <q-icon name="check_circle" size="16px" color="positive" />
      <span>{{ criterion }}</span>
    </div>
    <q-input
      v-model="evidenceForm.acceptance_notes[idx]"
      type="textarea"
      :rows="2"
      dense
      outlined
      placeholder="How was this criterion met?"
      class="criterion-input"
    />
  </div>
</div>
```

- [ ] **Step 4: Pass acceptance_notes in handleSubmitEvidence**

Find the `handleSubmitEvidence` handler. Update the store call to include `acceptance_notes`:

```typescript
const updated = await store.submitEvidence(props.contribution.id, {
  completion_notes: evidenceForm.value.completion_notes,
  evidence_urls: evidenceForm.value.evidence_urls.filter(u => u.trim()),
  actual_duration: evidenceForm.value.actual_duration,
  acceptance_notes: evidenceForm.value.acceptance_notes.filter(n => n.trim()),
});
```

- [ ] **Step 5: Add SCSS for the criterion response section**

In the `<style scoped>` section, add:

```scss
.evidence-criteria {
  margin-bottom: 1rem;

  .criterion-response {
    margin-bottom: 0.75rem;
  }

  .criterion-text {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
    font-size: 0.85rem;

    .q-icon { margin-top: 2px; flex-shrink: 0; }
  }

  .criterion-input { margin-left: 1.5rem; }
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/projects/ContributionDetailDialog.vue
git commit -m "feat: add per-criterion acceptance responses in evidence submission"
```

---

### Task 2: Add file upload zones to ContributionDetailDialog evidence form

**Files:**
- Modify: `frontend/src/components/projects/ContributionDetailDialog.vue`

Design reference: `ContributionDetailDialog.tsx` lines 675–845 — dashed border upload zones for time report and attachments, with file list display and remove buttons. Use the existing `AttachedFile` type from `frontend/src/types/projects.ts`.

- [ ] **Step 1: Add file state to evidenceForm and declare template refs**

In the `evidenceForm` ref, add:

```typescript
const evidenceForm = ref({
  completion_notes: '',
  evidence_urls: [''],
  actual_duration: undefined as number | undefined,
  acceptance_notes: [] as string[],
  time_report_file: null as AttachedFile | null,     // NEW
  attachment_files: [] as AttachedFile[],             // NEW
});

// Template refs for file inputs (Composition API pattern)
const timeReportInput = ref<HTMLInputElement | null>(null);
const attachmentInput = ref<HTMLInputElement | null>(null);
```

Ensure `AttachedFile` is imported from `@/types/projects`.

- [ ] **Step 2: Add file upload handler functions**

```typescript
function handleTimeReportUpload(file: File) {
  const url = URL.createObjectURL(file);
  evidenceForm.value.time_report_file = { name: file.name, url, type: file.type };
}

function handleAttachmentUpload(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    const url = URL.createObjectURL(file);
    evidenceForm.value.attachment_files.push({ name: file.name, url, type: file.type });
  }
}

function removeTimeReport() {
  const f = evidenceForm.value.time_report_file;
  if (f?.url.startsWith('blob:')) URL.revokeObjectURL(f.url);
  evidenceForm.value.time_report_file = null;
}

function removeAttachment(idx: number) {
  const file = evidenceForm.value.attachment_files[idx];
  if (file?.url.startsWith('blob:')) URL.revokeObjectURL(file.url);
  evidenceForm.value.attachment_files.splice(idx, 1);
}
```

- [ ] **Step 3: Add file upload UI to the evidence form template**

After the evidence URLs section in the template, add:

```html
<!-- Time Report Upload -->
<div class="file-upload-section">
  <div class="section-label">Time Report</div>
  <div v-if="!evidenceForm.time_report_file" class="file-drop-zone">
    <q-icon name="upload_file" size="32px" color="grey-6" />
    <div class="file-drop-text">Upload time report (.pdf, .csv, .xlsx)</div>
    <q-btn outline size="sm" label="Choose File" @click="timeReportInput?.click()" />
    <input
      ref="timeReportInput"
      type="file"
      accept=".pdf,.csv,.xlsx"
      style="display: none"
      @change="(e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (f) handleTimeReportUpload(f);
      }"
    />
  </div>
  <div v-else class="file-item">
    <q-icon name="description" size="20px" />
    <span class="file-name">{{ evidenceForm.time_report_file.name }}</span>
    <q-btn flat round dense icon="close" size="sm" @click="removeTimeReport" />
  </div>
</div>

<!-- Attachment Files Upload -->
<div class="file-upload-section">
  <div class="section-label">Attachments</div>
  <div class="file-drop-zone">
    <q-icon name="attach_file" size="32px" color="grey-6" />
    <div class="file-drop-text">Upload screenshots, documents, or other files</div>
    <q-btn outline size="sm" label="Choose Files" @click="attachmentInput?.click()" />
    <input
      ref="attachmentInput"
      type="file"
      multiple
      style="display: none"
      @change="(e: Event) => {
        const files = (e.target as HTMLInputElement).files;
        if (files?.length) handleAttachmentUpload(files);
      }"
    />
  </div>
  <div v-for="(file, idx) in evidenceForm.attachment_files" :key="idx" class="file-item">
    <q-icon name="description" size="20px" />
    <span class="file-name">{{ file.name }}</span>
    <q-btn flat round dense icon="close" size="sm" @click="removeAttachment(idx)" />
  </div>
</div>
```

- [ ] **Step 4: Pass file fields in handleSubmitEvidence**

Update the handler to include file fields:

```typescript
const updated = await store.submitEvidence(props.contribution.id, {
  completion_notes: evidenceForm.value.completion_notes,
  evidence_urls: evidenceForm.value.evidence_urls.filter(u => u.trim()),
  actual_duration: evidenceForm.value.actual_duration,
  acceptance_notes: evidenceForm.value.acceptance_notes.filter(n => n.trim()),
  time_report_file: evidenceForm.value.time_report_file ?? undefined,
  attachment_files: evidenceForm.value.attachment_files.length ? evidenceForm.value.attachment_files : undefined,
});
```

- [ ] **Step 5: Add SCSS for file upload zones**

```scss
.file-upload-section {
  margin-bottom: 1rem;
}

.file-drop-zone {
  border: 2px dashed $separator-color;
  border-radius: 8px;
  padding: 1.5rem;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;

  .file-drop-text {
    font-size: 0.8rem;
    color: $grey-7;
  }
}

.file-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid $separator-color;
  border-radius: 6px;
  margin-top: 0.5rem;

  .file-name {
    flex: 1;
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/projects/ContributionDetailDialog.vue
git commit -m "feat: add file upload zones for time report and attachments in evidence submission"
```

---

### Task 3: Add recursive child detail dialog to ContributionDetailDialog

**Files:**
- Modify: `frontend/src/components/projects/ContributionDetailDialog.vue`

Design reference: `ContributionDetailDialog.tsx` lines 582–638 (clickable sub-items) and lines 1184–1208 (nested dialog rendering).

- [ ] **Step 1: Add defineOptions and selectedChildContribution state**

At the top of `<script setup>`, add:

```typescript
defineOptions({ name: 'ContributionDetailDialog' });
```

Then add state for the child dialog:

```typescript
const selectedChildContribution = ref<Contribution | null>(null);
const showChildDialog = computed({
  get: () => !!selectedChildContribution.value,
  set: (v: boolean) => { if (!v) selectedChildContribution.value = null; },
});
```

- [ ] **Step 2: Add blockingChildren computed**

```typescript
const blockingChildren = computed(() =>
  childContributions.value.filter(c =>
    !['signed_off', 'rewarded', 'archived'].includes(c.status)
  )
);
```

- [ ] **Step 3: Make sub-contribution items clickable**

In the template, find the sub-contributions list (line 214–235). Add `@click` and `clickable` class to the sub-item div. Ensure the existing Approve button has `@click.stop` to prevent the click from bubbling:

```html
<div
  v-for="sub in childContributions"
  :key="sub.id"
  class="sub-item clickable"
  @click="selectedChildContribution = sub"
>
  <!-- existing content: status badge, title, approve button (keep @click.stop on approve btn) -->
</div>
```

- [ ] **Step 4: Replace blocking warning with individual child names**

Find the blocking warning section (around line 239). Replace the simple count message:

```html
<div v-if="hasBlockingChildren" class="blocking-warning">
  <q-icon name="warning" color="warning" size="20px" />
  <div>
    <div class="blocking-title">Sub-Contributions Not Complete</div>
    <div class="blocking-text">All sub-contributions must be signed off before submission:</div>
    <ul class="blocking-list">
      <li v-for="child in blockingChildren" :key="child.id">
        {{ child.title }} —
        <contribution-status-badge :status="child.status" size="sm" />
      </li>
    </ul>
  </div>
</div>
```

- [ ] **Step 5: Render the nested ContributionDetailDialog**

At the end of the template (before closing `</template>`), add the recursive dialog:

```html
<!-- Recursive child contribution dialog -->
<ContributionDetailDialog
  v-if="selectedChildContribution"
  v-model="showChildDialog"
  :contribution="selectedChildContribution"
  :user-role="userRole"
  :current-user-id="currentUserId"
  :current-user-name="currentUserName"
  :all-contributions="allContributions"
  :is-plan-signed-off="isPlanSignedOff"
  @update="(updated: Contribution) => {
    emit('update', updated);
    selectedChildContribution = null;
  }"
  @create-child-contribution="(parentId: string) => emit('create-child-contribution', parentId)"
/>
```

- [ ] **Step 6: Add SCSS for clickable sub-items and blocking list**

```scss
.sub-item.clickable {
  cursor: pointer;
  transition: background-color 0.15s;

  &:hover {
    background-color: rgba(0, 0, 0, 0.04);
  }
}

.blocking-warning {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  background: rgba(255, 152, 0, 0.08);
  border: 1px solid rgba(255, 152, 0, 0.2);
  border-radius: 8px;
  margin-top: 0.75rem;

  .blocking-title { font-weight: 600; font-size: 0.85rem; }
  .blocking-text { font-size: 0.8rem; color: $grey-7; margin-top: 0.25rem; }
  .blocking-list {
    margin: 0.5rem 0 0 0;
    padding-left: 1.25rem;
    font-size: 0.8rem;
    li { margin-bottom: 0.25rem; }
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/projects/ContributionDetailDialog.vue
git commit -m "feat: add recursive child dialog, clickable sub-items, and blocking child names"
```

---

## Chunk 2: ContributionCardCompact + MilestoneCard + Detail Page Fixes

### Task 4: Enhance ContributionCardCompact with design reference features

**Files:**
- Modify: `frontend/src/components/projects/ContributionCardCompact.vue`

Design reference: `ContributionCard.tsx` — shows description preview, estimated hours, ID, Share/Offer quick actions, sub-contribution preview with count + list.

- [ ] **Step 1: Add new emits and computed properties**

In `<script setup>`, add:

```typescript
// New emits (add to existing defineEmits):
(e: 'share', contribution: Contribution): void
(e: 'offer', contribution: Contribution): void

// New computed:
const isLead = computed(() =>
  ['community_admin', 'project_lead'].includes(props.userRole ?? '')
);
const isConfirmed = computed(() =>
  !['created', 'pending_approval'].includes(props.contribution.status)
);
const childContributions = computed(() => {
  const childIds = props.contribution.child_contributions ?? [];
  if (!childIds.length || !props.allContributions?.length) return [];
  return props.allContributions.filter(c => childIds.includes(c.id));
});
```

- [ ] **Step 2: Add description preview, hours, and ID to template**

After the title in the template, add:

```html
<!-- Description preview (2-line clamp) -->
<div v-if="contribution.description" class="compact-description">
  {{ contribution.description }}
</div>

<!-- Metadata row: hours + ID -->
<div class="compact-meta">
  <span v-if="contribution.estimated_hours" class="meta-item">
    <q-icon name="schedule" size="14px" /> {{ contribution.estimated_hours }}h
  </span>
  <span class="meta-item meta-id">ID: {{ contribution.id.slice(0, 12) }}</span>
</div>
```

- [ ] **Step 3: Add Share and Offer quick action buttons**

After the existing Confirm button, add:

```html
<template v-if="isPlanSignedOff && isLead && isConfirmed">
  <q-btn flat dense size="sm" label="Share" icon="share" @click.stop="emit('share', contribution)" />
  <q-btn flat dense size="sm" label="Offer" icon="person_add" @click.stop="emit('offer', contribution)" />
</template>
```

- [ ] **Step 4: Add sub-contribution preview section**

After the action buttons:

```html
<div v-if="childContributions.length > 0" class="sub-preview">
  <div class="sub-preview-header">
    <q-icon name="warning" size="14px" color="warning" />
    Sub-Contributions ({{ childContributions.length }})
  </div>
  <div
    v-for="child in childContributions.slice(0, 3)"
    :key="child.id"
    class="sub-preview-item"
    @click.stop="emit('view-detail', child)"
  >
    <span class="sub-preview-title">{{ child.title }}</span>
    <contribution-status-badge :status="child.status" size="sm" />
  </div>
  <div v-if="childContributions.length > 3" class="sub-preview-more">
    + {{ childContributions.length - 3 }} more
  </div>
</div>
```

- [ ] **Step 5: Add SCSS for new sections**

```scss
.compact-description {
  font-size: 0.8rem;
  color: $grey-7;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0.25rem 0;
}

.compact-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.75rem;
  color: $grey-6;
  margin: 0.25rem 0;

  .meta-item { display: flex; align-items: center; gap: 0.25rem; }
  .meta-id { margin-left: auto; }
}

.sub-preview {
  border-top: 1px solid $separator-color;
  padding-top: 0.5rem;
  margin-top: 0.5rem;

  .sub-preview-header {
    display: flex; align-items: center; gap: 0.25rem;
    font-size: 0.75rem; font-weight: 600; margin-bottom: 0.25rem;
  }

  .sub-preview-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: 0.25rem 0.5rem; background: rgba(0, 0, 0, 0.02); border-radius: 4px;
    margin-bottom: 0.25rem; font-size: 0.75rem; cursor: pointer;
    &:hover { background: rgba(0, 0, 0, 0.05); }
  }

  .sub-preview-title {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1; margin-right: 0.5rem;
  }

  .sub-preview-more { font-size: 0.7rem; color: $grey-6; padding-left: 0.5rem; }
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/projects/ContributionCardCompact.vue
git commit -m "feat: add description, hours, ID, Share/Offer actions, and sub-contribution preview to compact card"
```

---

### Task 5: Wire new compact card emits in MilestoneCard and add progress bar

**Files:**
- Modify: `frontend/src/components/projects/MilestoneCard.vue`

Design reference: `MilestoneCard.tsx` — shows completion progress bar and contribution count. The existing header already has milestone number and duration — only progress bar and count are missing. Also needs to forward the new `share` and `offer` emits from ContributionCardCompact.

- [ ] **Step 1: Add progress computed properties**

In `<script setup>`, add:

```typescript
const confirmedCount = computed(() =>
  contributions.value.filter(c => c.status !== 'created').length
);
const totalCount = computed(() => contributions.value.length);
const progressPercent = computed(() =>
  totalCount.value === 0 ? 0 : Math.round((confirmedCount.value / totalCount.value) * 100)
);
```

- [ ] **Step 2: Add contribution count to header**

In the existing `milestone-header-right` section (around line 17), add a contribution count next to the existing badges:

```html
<span class="milestone-meta-count">{{ totalCount }} contributions</span>
```

- [ ] **Step 3: Add progress bar below header, before contributions body**

After the header div, before the expandable body:

```html
<q-linear-progress
  v-if="totalCount > 0 && isExpanded"
  :value="progressPercent / 100"
  color="primary"
  track-color="grey-3"
  rounded
  size="6px"
  class="milestone-progress"
/>
<div v-if="totalCount > 0 && isExpanded" class="milestone-progress-label">
  {{ confirmedCount }} of {{ totalCount }} confirmed
</div>
```

- [ ] **Step 4: Add new emits and forward from ContributionCardCompact**

Add to the emits definition:

```typescript
(e: 'share-contribution', contribution: Contribution): void
(e: 'offer-contribution', contribution: Contribution): void
```

On the `ContributionCardCompact` usage in the template, add event forwarding:

```html
<ContributionCardCompact
  ...existing-props...
  @share="(c: Contribution) => emit('share-contribution', c)"
  @offer="(c: Contribution) => emit('offer-contribution', c)"
/>
```

- [ ] **Step 5: Add SCSS**

```scss
.milestone-meta-count {
  font-size: 0.75rem;
  color: $grey-7;
}

.milestone-progress {
  margin: 0.5rem 1rem 0;
}

.milestone-progress-label {
  font-size: 0.7rem;
  color: $grey-6;
  padding: 0.25rem 1rem;
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/projects/MilestoneCard.vue
git commit -m "feat: add progress bar, contribution count, and wire share/offer emits in MilestoneCard"
```

---

### Task 6: Add evidence URLs to ContributionDetailPage evidence dialog

**Files:**
- Modify: `frontend/src/pages/Contributions/ContributionDetailPage.vue`

The ContributionDetailDialog already has evidence URLs in its form, but the page-level evidence dialog is missing them.

- [ ] **Step 1: Add evidenceUrls state**

In the reactive state section, add:

```typescript
const evidenceUrls = ref<string[]>([]);
const newEvidenceUrl = ref('');
```

- [ ] **Step 2: Add URL list UI to evidence dialog**

Find the evidence dialog (around line 228). After the `evidenceNotes` textarea and before the hours input, add:

```html
<!-- Evidence URLs -->
<div class="q-mb-md">
  <div class="text-caption q-mb-xs">Evidence URLs</div>
  <div v-for="(url, idx) in evidenceUrls" :key="idx" class="row items-center q-mb-xs">
    <q-icon name="link" size="18px" class="q-mr-sm" />
    <span class="col text-body2" style="word-break: break-all;">{{ url }}</span>
    <q-btn flat round dense icon="close" size="sm" @click="evidenceUrls.splice(idx, 1)" />
  </div>
  <div class="row items-center q-gutter-sm">
    <q-input
      v-model="newEvidenceUrl"
      dense
      outlined
      placeholder="https://github.com/..."
      class="col"
      @keyup.enter="if (newEvidenceUrl.trim()) { evidenceUrls.push(newEvidenceUrl.trim()); newEvidenceUrl = ''; }"
    />
    <q-btn
      flat dense icon="add"
      :disable="!newEvidenceUrl.trim()"
      @click="evidenceUrls.push(newEvidenceUrl.trim()); newEvidenceUrl = '';"
    />
  </div>
</div>
```

- [ ] **Step 3: Pass URLs in handleSubmitEvidence**

Update the handler:

```typescript
await store.submitEvidence(contribution.value!.id, {
  completion_notes: evidenceNotes.value,
  actual_duration: evidenceHours.value,
  evidence_urls: evidenceUrls.value,
});
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Contributions/ContributionDetailPage.vue
git commit -m "feat: add evidence URLs to ContributionDetailPage evidence dialog"
```

---

### Task 7: Replace q-slider with 10-star click interface on ContributionDetailPage

**Files:**
- Modify: `frontend/src/pages/Contributions/ContributionDetailPage.vue`

The `ContributionDetailDialog.vue` already uses a 10-star interface (lines 357–370). The page-level review dialog incorrectly uses a `q-slider`. This task makes them consistent.

- [ ] **Step 1: Replace the q-slider with star icons in the review dialog**

Find the review dialog's quality rating `q-slider` (around line 274). Replace:

```html
<q-slider v-model="reviewRating" :min="1" :max="10" :step="1" label />
```

With:

```html
<div class="star-rating">
  <q-icon
    v-for="i in 10"
    :key="i"
    :name="i <= reviewRating ? 'star' : 'star_border'"
    :color="i <= reviewRating ? 'amber' : 'grey-4'"
    size="24px"
    class="star-icon"
    @click="reviewRating = i"
  />
  <span class="rating-label">{{ reviewRating }} / 10</span>
</div>
```

- [ ] **Step 2: Replace the read-only rating display in the feedback slot**

Find where `quality_rating` is displayed read-only. Replace with filled/empty stars:

```html
<div v-if="contribution.quality_rating" class="star-rating">
  <q-icon
    v-for="i in 10"
    :key="i"
    :name="i <= contribution.quality_rating ? 'star' : 'star_border'"
    :color="i <= contribution.quality_rating ? 'amber' : 'grey-4'"
    size="18px"
  />
  <span class="rating-label">{{ contribution.quality_rating }} / 10</span>
</div>
```

- [ ] **Step 3: Add SCSS**

```scss
.star-rating {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;

  .star-icon { cursor: pointer; transition: color 0.1s; }
  .rating-label { margin-left: 0.5rem; font-size: 0.85rem; color: $grey-7; }
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Contributions/ContributionDetailPage.vue
git commit -m "feat: replace q-slider with 10-star click interface for quality rating"
```

---

### Task 8: Final build verification

- [ ] **Step 1: Type check**

Run: `cd frontend && npx vue-tsc --noEmit 2>&1 | tail -5`
Expected: No new errors.

- [ ] **Step 2: Lint**

Run: `cd frontend && npm run lint 2>&1 | tail -10`
Fix any lint errors introduced by the changes.

- [ ] **Step 3: Build check**

Run: `cd frontend && npm run build 2>&1 | tail -10`
Expected: Build succeeds.

- [ ] **Step 4: Commit any lint fixes**

```bash
git add frontend/src/components/projects/ContributionDetailDialog.vue frontend/src/components/projects/ContributionCardCompact.vue frontend/src/components/projects/MilestoneCard.vue frontend/src/pages/Contributions/ContributionDetailPage.vue
git commit -m "chore: lint fixes for UI gap implementations"
```
