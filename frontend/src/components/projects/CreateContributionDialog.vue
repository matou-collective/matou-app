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
              {{ editing ? 'Change Contribution' : parentContributionId ? 'Add Sub-Contribution' : 'Create Contribution' }}
            </div>
            <div v-if="parentContributionId" class="text-caption text-muted">
              Sub-task of parent contribution
            </div>
          </div>
        </div>
        <q-btn icon="close" flat round dense v-close-popup @click="resetForm" />
      </div>

      <q-card-section class="form-body q-gutter-md">
        <!-- Re-confirmation warning (edit mode only) -->
        <q-banner v-if="editing" class="change-warning q-mb-md" rounded>
          <template #avatar>
            <q-icon name="warning" color="warning" />
          </template>
          <div class="text-subtitle2">This change requires re-confirmation</div>
          <div class="text-caption">After submitting, the contribution will need to be re-confirmed by a steward before work can continue.</div>
        </q-banner>

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
        <div v-if="!editing">
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
        <div v-if="editing" class="q-mb-md">
          <div class="field-label">Contribution Type</div>
          <q-badge :label="form.contribution_type" color="primary" />
          <div class="text-caption text-grey-6">Type cannot be changed after creation</div>
        </div>

        <!-- Duration & Deadline -->
        <div class="inline-row">
          <q-input
            v-model.number="form.estimated_hours"
            label="Estimated Hours"
            type="number"
            outlined
            min="0"
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

        <!-- Budget -->
        <q-input v-model="form.budget" label="Budget" outlined placeholder="e.g. $500" />

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
        <!-- Reason for change (edit mode only) -->
        <div v-if="editing" class="q-mb-md">
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
      </q-card-section>

      <div class="dialog-footer">
        <q-btn
          no-caps
          :label="editing ? 'Submit Change' : parentContributionId ? 'Create Sub-Contribution' : 'Create Contribution'"
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

interface Props {
  modelValue: boolean;
  projectId: string;
  milestoneId?: string;
  parentContributionId?: string;
  isSubmitting?: boolean;
  editing?: boolean;
  contribution?: Contribution | null;
}

const props = withDefaults(defineProps<Props>(), {
  milestoneId: undefined,
  parentContributionId: undefined,
  isSubmitting: false,
  editing: false,
  contribution: null,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'submit', req: CreateContributionRequest): void;
  (e: 'change', data: { updates: Record<string, unknown>; reason: string }): void;
}>();

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
  };
}

const form = ref<ContributionForm>(makeDefault());
const changeReason = ref('');

const isValid = computed(
  () =>
    form.value.title.trim().length > 0 &&
    form.value.description.trim().length > 0 &&
    !!form.value.contribution_type &&
    form.value.objectives.some((o) => o.trim()) &&
    form.value.deliverables.some((d) => d.trim()),
);

watch(
  () => props.modelValue,
  (open) => {
    if (open && props.editing && props.contribution) {
      const c = props.contribution;
      form.value.title = c.title || '';
      form.value.description = c.description || '';
      form.value.contribution_type = c.contribution_type || 'coding_technical_dev';
      form.value.estimated_hours = c.estimated_hours ?? undefined;
      // Convert ISO yyyy-mm-dd to dd-mm-yyyy for display
      form.value.deadline = c.deadline ? c.deadline.split('-').reverse().join('-') : '';
      form.value.budget = c.budget || '';
      form.value.objectives = c.objectives?.length ? [...c.objectives] : [''];
      form.value.deliverables = c.deliverables?.length ? [...c.deliverables] : [''];
      form.value.acceptance_criteria = c.acceptance_criteria?.length ? [...c.acceptance_criteria] : [''];
      form.value.skill_requirements = c.skill_requirements?.length ? [...c.skill_requirements] : [''];
      changeReason.value = '';
    } else if (!open) {
      resetForm();
      changeReason.value = '';
    }
  },
);

function resetForm() {
  form.value = makeDefault();
}

function handleSubmit() {
  if (!isValid.value) return;

  if (props.editing && props.contribution) {
    if (!changeReason.value.trim()) return;
    emit('change', {
      updates: {
        title: form.value.title.trim(),
        description: form.value.description.trim(),
        objectives: form.value.objectives.filter((o) => o.trim()),
        deliverables: form.value.deliverables.filter((d) => d.trim()),
        acceptance_criteria: form.value.acceptance_criteria.filter((a) => a.trim()),
        skill_requirements: form.value.skill_requirements.filter((s) => s.trim()),
        estimated_hours: form.value.estimated_hours,
        budget: form.value.budget?.trim() || undefined,
      },
      reason: changeReason.value.trim(),
    });
    emit('update:modelValue', false);
    return;
  }

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
  border-radius: 10px;
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
