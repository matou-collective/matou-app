<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card class="contribution-dialog">
      <div class="dialog-header">
        <div class="dialog-header-left">
          <PlusCircle class="header-icon" />
          <div>
            <div class="text-h6">
              {{ changeRequest ? 'Change Contribution' : editing ? 'Edit Contribution' : parentContributionId ? 'Add Sub-Contribution' : 'Create Contribution' }}
            </div>
            <div v-if="parentContributionId" class="text-caption text-muted">
              Sub-task of parent contribution
            </div>
          </div>
        </div>
        <q-btn icon="close" flat round dense v-close-popup @click="resetForm" />
      </div>

      <q-card-section class="form-body q-gutter-md">
        <!-- Re-confirmation warning (change-request mode only) -->
        <q-banner v-if="changeRequest" class="change-warning q-mb-md" rounded>
          <template #avatar>
            <q-icon name="warning" color="warning" />
          </template>
          <div class="text-subtitle2">This change requires re-confirmation</div>
          <div class="text-caption">After submitting, the contribution will need to be re-confirmed by a steward before work can continue.</div>
        </q-banner>

        <!-- Project picker (standalone create mode only) -->
        <q-select
          v-if="standalone && !editing"
          v-model="form.project_id"
          :options="projectOptions"
          option-label="label"
          option-value="value"
          emit-value
          map-options
          outlined
          label="Project *"
          hint="The project this contribution belongs to"
        />

        <!-- Title -->
        <q-input v-model="form.title" label="Title *" outlined />

        <!-- Description -->
        <q-input
          v-model="form.description"
          label="Description *"
          type="textarea"
          outlined
          autogrow
        />

        <!-- Contribution Type -->
        <div v-if="!changeRequest">
          <div class="text-subtitle2 q-mb-sm">Contribution Type *</div>
          <div class="type-card-grid">
            <button
              v-for="t in typeOptions"
              :key="t.value"
              class="type-card"
              :class="{ active: form.contribution_type === t.value }"
              @click="form.contribution_type = t.value"
              type="button"
            >
              <component :is="t.icon" class="type-card-icon" />
              <span class="type-card-label">{{ t.label }}</span>
            </button>
          </div>
        </div>
        <div v-else class="q-mb-md">
          <div class="field-label">Contribution Type</div>
          <q-badge :label="form.contribution_type" color="primary" />
          <div class="text-caption text-grey-6">Type cannot be changed after creation</div>
        </div>

        <!-- Contributor picker (sub-create mode, sub-edit mode, and
             top-level reassign when the contribution is already assigned). -->
        <div
          v-if="parentContributionId || (editing && contribution?.parent_contribution) || showReassignPicker"
        >
          <div class="text-subtitle2 q-mb-sm">
            {{ showReassignPicker ? 'Reassign Contributor' : 'Assigned Contributor' }}
          </div>
          <MemberPicker
            v-model="form.assigned_contributor_id"
            :members="contributorMembers"
            allow-toggle
          />
          <div class="text-caption text-grey-6 q-mt-xs">
            {{ showReassignPicker
              ? 'Pick a different community member. The contribution will move back to "changed" so they can re-confirm.'
              : 'Defaults to the parent\'s contributor when known. Leave blank to assign later.' }}
          </div>
        </div>

        <!-- Estimated Hours, Budget & Due Date -->
        <div class="inline-row">
          <q-input
            v-model.number="form.estimated_duration"
            label="Estimated Hours"
            type="number"
            outlined
            min="0"
          />
          <q-input
            v-if="canSeeBudgetForThis"
            v-model="form.budget"
            label="Budget"
            outlined
            placeholder="e.g. $500"
          />
          <q-input
            v-model="form.deadline"
            label="Due Date"
            outlined
            mask="##-##-####"
            placeholder="dd-mm-yyyy"
          >
            <template #append>
              <q-icon name="event" class="cursor-pointer">
                <q-popup-proxy cover transition-show="scale" transition-hide="scale">
                  <q-date
                    :model-value="toQDateFormat(form.deadline)"
                    @update:model-value="form.deadline = fromQDateFormat($event)"
                    mask="YYYY/MM/DD"
                  >
                    <div class="row items-center justify-end">
                      <q-btn v-close-popup label="Close" color="primary" flat />
                    </div>
                  </q-date>
                </q-popup-proxy>
              </q-icon>
            </template>
          </q-input>
        </div>

        <!-- Objectives -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Objectives *</div>
          <div
            v-for="(_, i) in form.objectives"
            :key="i"
            class="list-row q-mb-sm"
          >
            <q-input
              v-model="form.objectives[i]"
              :label="`Objective ${i + 1}`"
              type="textarea"
              autogrow
              outlined
              class="list-input"
            />
            <q-btn
              flat
              round
              icon="remove_circle_outline"
              color="negative"
              size="sm"
              @click="form.objectives.splice(i, 1)"
              :disable="form.objectives.length <= 1"
            />
          </div>
          <q-btn
            flat
            size="sm"
            icon="add"
            no-caps
            label="Add Objective"
            color="primary"
            @click="form.objectives.push('')"
          />
        </div>

        <!-- Deliverables -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Deliverables *</div>
          <div
            v-for="(_, i) in form.deliverables"
            :key="i"
            class="list-row q-mb-sm"
          >
            <q-input
              v-model="form.deliverables[i]"
              :label="`Deliverable ${i + 1}`"
              type="textarea"
              autogrow
              outlined
              class="list-input"
            />
            <q-btn
              flat
              round
              icon="remove_circle_outline"
              color="negative"
              size="sm"
              @click="form.deliverables.splice(i, 1)"
              :disable="form.deliverables.length <= 1"
            />
          </div>
          <q-btn
            flat
            size="sm"
            icon="add"
            no-caps
            label="Add Deliverable"
            color="primary"
            @click="form.deliverables.push('')"
          />
        </div>

        <!-- Acceptance Criteria -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Acceptance Criteria</div>
          <div
            v-for="(_, i) in form.acceptance_criteria"
            :key="i"
            class="list-row q-mb-sm"
          >
            <q-input
              v-model="form.acceptance_criteria[i]"
              :label="`Criterion ${i + 1}`"
              type="textarea"
              autogrow
              outlined
              class="list-input"
            />
            <q-btn
              flat
              round
              icon="remove_circle_outline"
              color="negative"
              size="sm"
              @click="form.acceptance_criteria.splice(i, 1)"
              :disable="form.acceptance_criteria.length <= 1"
            />
          </div>
          <q-btn
            flat
            size="sm"
            icon="add"
            no-caps
            label="Add Criterion"
            color="primary"
            @click="form.acceptance_criteria.push('')"
          />
        </div>

        <!-- Skill Requirements -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Skill Requirements</div>
          <div
            v-for="(_, i) in form.skill_requirements"
            :key="i"
            class="list-row q-mb-sm"
          >
            <q-input
              v-model="form.skill_requirements[i]"
              :label="`Skill ${i + 1}`"
              outlined
              dense
              class="list-input"
            />
            <q-btn
              flat
              round
              icon="remove_circle_outline"
              color="negative"
              size="sm"
              @click="form.skill_requirements.splice(i, 1)"
              :disable="form.skill_requirements.length <= 1"
            />
          </div>
          <q-btn
            flat
            size="sm"
            icon="add"
            no-caps
            label="Add Skill"
            color="primary"
            @click="form.skill_requirements.push('')"
          />
        </div>
        <!-- Reason for change (change-request mode only) -->
        <div v-if="changeRequest" class="q-mb-md">
          <div class="field-label">Reason for Change *</div>
          <q-input
            v-model="changeReason"
            type="textarea"
            :rows="3"
            dense
            outlined
            placeholder="Explain why this contribution needs to change..."
            :rules="[val => !!val?.trim() || 'Reason is required']"
          />
        </div>

        <div
          v-if="showUnassignBlock"
          class="unassign-block q-mt-sm"
        >
          <q-btn
            outline
            no-caps
            color="negative"
            icon="person_remove"
            label="Unassign Contributor"
            @click="$emit('unassign')"
          />
        </div>

        <div v-if="editing && canDelete" class="danger-zone q-mt-md">
          <div class="danger-zone-title">Danger Zone</div>
          <q-btn
            outline
            no-caps
            color="negative"
            icon="delete"
            label="Delete Contribution"
            @click="$emit('archive')"
          />
        </div>
      </q-card-section>

      <div class="dialog-footer">
        <q-btn
          no-caps
          :label="changeRequest ? 'Submit Change' : editing ? 'Save Changes' : parentContributionId ? 'Create Sub-Contribution' : 'Create Contribution'"
          color="primary"
          class="dialog-footer-btn"
          :loading="isSubmitting"
          :disable="!isValid"
          @click="handleSubmit"
        />
        <q-btn outline no-caps label="Cancel" color="primary" class="dialog-footer-btn" v-close-popup @click="resetForm" />
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { PlusCircle, Search, Settings, Palette, MessageCircle, Code2, Landmark } from 'lucide-vue-next';
import type { CreateContributionRequest } from 'src/lib/api/contributions';
import type { Contribution } from 'src/types/projects';
import { useProfilesStore } from 'stores/profiles';
import { useProjectsStore } from 'stores/projects';
import { useContributionBudgetAccess } from 'src/composables/useContributionBudgetAccess';
import MemberPicker from 'src/components/common/MemberPicker.vue';
import type { MemberOption } from 'src/components/common/MemberPicker.vue';

interface Props {
  modelValue: boolean;
  projectId?: string;
  milestoneId?: string;
  parentContributionId?: string;
  parentAssignedContributorId?: string;
  isSubmitting?: boolean;
  editing?: boolean;
  /**
   * When true, the form runs the "request changes" workflow: shows a re-confirmation
   * warning, requires a Reason for Change, locks the contribution type, and emits
   * `change` with reason + updates. When false (default), `editing` behaves as a plain
   * edit that mirrors the Create UI and emits `submit` with an update payload.
   */
  changeRequest?: boolean;
  contribution?: Contribution | null;
  standalone?: boolean;
  /**
   * When true and editing a top-level contribution that already has an
   * assignee, the Assigned Contributor picker becomes editable so a
   * lead/steward can reassign. Parent is responsible for the lead/steward
   * + status gate.
   */
  canReassign?: boolean;
  canUnassign?: boolean;
  canDelete?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  projectId: '',
  milestoneId: undefined,
  parentContributionId: undefined,
  parentAssignedContributorId: undefined,
  isSubmitting: false,
  editing: false,
  changeRequest: false,
  contribution: null,
  standalone: false,
  canReassign: false,
  canUnassign: false,
  canDelete: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'submit', req: CreateContributionRequest): void;
  (e: 'update', updates: Record<string, unknown>): void;
  (e: 'change', data: { updates: Record<string, unknown>; reason: string }): void;
  (e: 'unassign'): void;
  (e: 'archive'): void;
}>();

const profilesStore = useProfilesStore();
const projectsStore = useProjectsStore();
const budgetAccess = useContributionBudgetAccess();

const projectOptions = computed(() =>
  projectsStore.projects
    .filter((p) => p.status !== 'archived')
    .map((p) => ({ label: p.title, value: p.id })),
);

const contributorMembers = computed<MemberOption[]>(() =>
  profilesStore.communityProfiles
    .map((p) => {
      const id = (p.data?.aid as string) ?? '';
      const name = (p.data?.displayName as string) ?? id.slice(0, 12) + '...';
      const status = (p.data?.status as string) ?? '';
      return { id, name, status };
    })
    .filter((m) => m.id && m.status !== 'removed' && m.status !== 'pending')
    .map(({ id, name }) => ({ id, name })),
);

interface ContributionForm {
  project_id: string;
  title: string;
  description: string;
  contribution_type: string;
  estimated_duration: number | undefined;
  deadline: string;
  budget: string;
  objectives: string[];
  deliverables: string[];
  acceptance_criteria: string[];
  skill_requirements: string[];
  assigned_contributor_id: string;
}

const typeOptions = [
  { value: 'research_knowledge', label: 'Research', icon: Search },
  { value: 'coordination_operations', label: 'Ops', icon: Settings },
  { value: 'art_design', label: 'Design', icon: Palette },
  { value: 'discussion_community_input', label: 'Community', icon: MessageCircle },
  { value: 'coding_technical_dev', label: 'Technical', icon: Code2 },
  { value: 'cultural_oversight', label: 'Cultural', icon: Landmark },
];

// Convert dd-mm-yyyy to YYYY/MM/DD for q-date
function toQDateFormat(ddmmyyyy: string): string {
  if (!ddmmyyyy || ddmmyyyy.length !== 10) return '';
  const [dd, mm, yyyy] = ddmmyyyy.split('-');
  return `${yyyy}/${mm}/${dd}`;
}

// Convert YYYY/MM/DD from q-date to dd-mm-yyyy for display
function fromQDateFormat(qdate: string): string {
  if (!qdate) return '';
  const [yyyy, mm, dd] = qdate.split('/');
  return `${dd}-${mm}-${yyyy}`;
}

// Convert dd-mm-yyyy to yyyy-mm-dd (ISO) for backend
function toISODate(ddmmyyyy: string): string {
  if (!ddmmyyyy || ddmmyyyy.length !== 10) return '';
  const [dd, mm, yyyy] = ddmmyyyy.split('-');
  return `${yyyy}-${mm}-${dd}`;
}

// Convert RFC3339 (e.g. "2026-12-01T00:00:00Z") or ISO date back to dd-mm-yyyy
function fromISOToDDMMYYYY(iso: string | undefined | null): string {
  if (!iso) return '';
  // Take just the yyyy-mm-dd portion
  const datePart = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return '';
  const [yyyy, mm, dd] = datePart.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

function makeDefault(): ContributionForm {
  return {
    project_id: props.projectId ?? '',
    title: '',
    description: '',
    contribution_type: 'coding_technical_dev',
    estimated_duration: undefined,
    deadline: '',
    budget: '',
    objectives: [''],
    deliverables: [''],
    acceptance_criteria: [''],
    skill_requirements: [''],
    assigned_contributor_id: '',
  };
}

const form = ref<ContributionForm>(makeDefault());
const changeReason = ref('');

const canSeeBudgetForThis = computed(() =>
  budgetAccess.canSeeBudget({ project_id: props.projectId || form.value.project_id }),
);

// Show the Reassign picker only when editing a top-level contribution that
// (a) the parent says is reassignable AND (b) is in a status where a swap
// is meaningful AND (c) already has an assignee.
const showReassignPicker = computed(() => {
  if (!props.editing) return false;
  if (!props.canReassign) return false;
  const c = props.contribution;
  if (!c) return false;
  if (c.parent_contribution) return false;
  if (!['assigned', 'changed'].includes(c.status)) return false;
  const currentAid = c.assigned_contributor_id ?? c.assigned_contributor;
  return !!currentAid;
});

const showUnassignBlock = computed(() => {
  if (!props.editing) return false;
  if (!props.canUnassign) return false;
  const c = props.contribution;
  if (!c) return false;
  if (c.status !== 'assigned') return false;
  const currentAid = c.assigned_contributor_id ?? (c as { assigned_contributor?: string }).assigned_contributor;
  return !!currentAid;
});

const isValid = computed(() => {
  const baseValid =
    form.value.title.trim().length > 0 &&
    form.value.description.trim().length > 0 &&
    !!form.value.contribution_type &&
    form.value.objectives.some((o) => o.trim()) &&
    form.value.deliverables.some((d) => d.trim());
  if (!baseValid) return false;
  if (props.standalone && !props.editing && !form.value.project_id) return false;
  return true;
});

// Single merged watcher for modelValue:
// - loads community profiles in sub-create mode if the store is empty
// - seeds the form when opening in edit mode
// - pre-fills the contributor picker when opening in sub-create mode
// - resets form and changeReason on close
watch(
  () => props.modelValue,
  (open) => {
    if (open && props.parentContributionId && profilesStore.communityProfiles.length === 0) {
      void profilesStore.loadCommunityProfiles();
    }

    // Also load community profiles in sub-edit mode so the picker is populated
    if (open && props.editing && props.contribution?.parent_contribution && profilesStore.communityProfiles.length === 0) {
      void profilesStore.loadCommunityProfiles();
    }

    // Standalone mode: ensure projects are loaded so the picker has options
    if (open && props.standalone && projectsStore.projects.length === 0) {
      void projectsStore.fetchProjects();
    }

    if (open && props.editing && props.contribution) {
      const c = props.contribution;
      form.value.title = c.title || '';
      form.value.description = c.description || '';
      form.value.contribution_type = c.contribution_type || 'coding_technical_dev';
      form.value.estimated_duration = c.estimated_duration ?? undefined;
      // Convert ISO timestamp (RFC3339 like "2026-12-01T00:00:00Z" or yyyy-mm-dd) to dd-mm-yyyy for display
      form.value.deadline = fromISOToDDMMYYYY(c.deadline);
      form.value.budget = c.budget || '';
      form.value.objectives = c.objectives?.length ? [...c.objectives] : [''];
      form.value.deliverables = c.deliverables?.length ? [...c.deliverables] : [''];
      form.value.acceptance_criteria = c.acceptance_criteria?.length ? [...c.acceptance_criteria] : [''];
      form.value.skill_requirements = c.skill_requirements?.length ? [...c.skill_requirements] : [''];
      form.value.assigned_contributor_id = c.assigned_contributor_id ?? c.assigned_contributor ?? '';
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
  { immediate: true },
);

function resetForm() {
  form.value = makeDefault();
}

function handleSubmit() {
  if (!isValid.value) return;

  // "Change request" workflow — emit `change` with reason + updates
  if (props.editing && props.changeRequest && props.contribution) {
    if (!changeReason.value.trim()) return;
    const isSub = !!props.contribution.parent_contribution;
    emit('change', {
      updates: {
        title: form.value.title.trim(),
        description: form.value.description.trim(),
        objectives: form.value.objectives.filter((o) => o.trim()),
        deliverables: form.value.deliverables.filter((d) => d.trim()),
        acceptance_criteria: form.value.acceptance_criteria.filter((a) => a.trim()),
        skill_requirements: form.value.skill_requirements.filter((s) => s.trim()),
        estimated_duration: form.value.estimated_duration,
        deadline: toISODate(form.value.deadline) || undefined,
        budget: form.value.budget?.trim() || undefined,
        ...(isSub && form.value.assigned_contributor_id
          ? { assigned_contributor_id: form.value.assigned_contributor_id }
          : {}),
      },
      reason: changeReason.value.trim(),
    });
    emit('update:modelValue', false);
    return;
  }

  // Plain edit — emit `update` with the update payload.
  if (props.editing && props.contribution) {
    emit('update', {
      title: form.value.title.trim(),
      description: form.value.description.trim(),
      contribution_type: form.value.contribution_type,
      objectives: form.value.objectives.filter((o) => o.trim()),
      deliverables: form.value.deliverables.filter((d) => d.trim()),
      acceptance_criteria: form.value.acceptance_criteria.filter((a) => a.trim()),
      skill_requirements: form.value.skill_requirements.filter((s) => s.trim()),
      estimated_duration: form.value.estimated_duration,
      deadline: toISODate(form.value.deadline) || undefined,
      budget: form.value.budget?.trim() || undefined,
      ...(form.value.assigned_contributor_id
        ? { assigned_contributor_id: form.value.assigned_contributor_id }
        : {}),
    });
    emit('update:modelValue', false);
    return;
  }

  const req: CreateContributionRequest = {
    project_id: props.projectId || form.value.project_id,
    milestone_id: props.milestoneId,
    title: form.value.title.trim(),
    description: form.value.description.trim(),
    contribution_type: form.value.contribution_type,
    priority: 'medium',
    objectives: form.value.objectives.filter((o) => o.trim()),
    deliverables: form.value.deliverables.filter((d) => d.trim()),
    acceptance_criteria: form.value.acceptance_criteria.filter((a) => a.trim()),
    skill_requirements: form.value.skill_requirements.filter((s) => s.trim()),
    estimated_duration: form.value.estimated_duration,
    deadline: toISODate(form.value.deadline) || undefined,
    budget: form.value.budget.trim() || undefined,
    created_by: 'current-user',
    ...(form.value.assigned_contributor_id ? { assigned_contributor_id: form.value.assigned_contributor_id } : {}),
  };
  emit('submit', req);
}
</script>

<style scoped lang="scss">
.contribution-dialog {
  min-width: 560px;
  max-width: 720px;
  width: 100%;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 0;
}

.dialog-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-icon {
  width: 20px;
  height: 20px;
  color: var(--matou-primary);
}

.form-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.dialog-footer {
  display: flex;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--matou-border);
}

.dialog-footer-btn {
  flex: 1;
}

// Contribution type cards (3 columns)
.type-card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}

.type-card {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px 10px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  background: var(--matou-card);
  cursor: pointer;
  transition: all 0.12s ease;

  &:hover {
    border-color: var(--matou-accent);
    background: var(--matou-secondary);
  }

  &.active {
    border-color: var(--matou-primary);
    background: rgba(30, 95, 116, 0.06);
  }
}

.type-card-icon {
  width: 16px;
  height: 16px;
  color: var(--matou-muted-foreground);
  flex-shrink: 0;

  .type-card.active & {
    color: var(--matou-primary);
  }
}

.type-card-label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--matou-muted-foreground);

  .type-card.active & {
    color: var(--matou-primary);
  }
}

// Change warning banner
.change-warning {
  background: rgba(255, 152, 0, 0.08);
  border: 1px solid rgba(255, 152, 0, 0.2);
}

// List rows
.list-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.list-input {
  flex: 1;
}

.inline-row {
  display: flex;
  gap: 16px;

  > * {
    flex: 1;
  }
}

</style>
