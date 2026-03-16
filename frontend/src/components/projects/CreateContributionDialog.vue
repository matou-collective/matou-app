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

        <!-- Type selector (2x2 grid) — read-only in edit mode -->
        <div v-if="!editing">
          <div class="text-subtitle2 q-mb-sm">Contribution Type *</div>
          <div class="type-grid">
            <button
              v-for="t in typeOptions"
              :key="t.value"
              class="type-btn"
              :class="{ active: form.contribution_type === t.value }"
              @click="form.contribution_type = t.value"
              type="button"
            >
              <component :is="t.icon" class="type-btn-icon" />
              <span>{{ t.label }}</span>
            </button>
          </div>
        </div>
        <div v-if="editing" class="q-mb-md">
          <div class="field-label">Contribution Type</div>
          <q-badge :label="form.contribution_type" color="primary" />
          <div class="text-caption text-grey-6">Type cannot be changed after creation</div>
        </div>

        <!-- Priority selector (2x2 grid) -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Priority *</div>
          <div class="priority-grid">
            <button
              v-for="p in priorityOptions"
              :key="p.value"
              class="priority-btn"
              :class="[p.value, { active: form.priority === p.value }]"
              @click="form.priority = p.value"
              type="button"
            >
              {{ p.label }}
            </button>
          </div>
        </div>

        <!-- Duration & Deadline -->
        <div class="row q-col-gutter-md">
          <div class="col-6">
            <q-input
              v-model.number="form.estimated_hours"
              label="Estimated Hours"
              type="number"
              outlined
              min="0"
            />
          </div>
          <div class="col-6">
            <q-input
              v-model="form.deadline"
              label="Deadline"
              type="date"
              outlined
            />
          </div>
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
        <q-btn flat no-caps label="Cancel" v-close-popup @click="resetForm" />
        <q-btn
          no-caps
          :label="editing ? 'Submit Change' : parentContributionId ? 'Create Sub-Contribution' : 'Create Contribution'"
          color="primary"
          :loading="isSubmitting"
          :disable="!isValid"
          @click="handleSubmit"
        />
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { PlusCircle, Scale, Code2, Landmark, Users } from 'lucide-vue-next';
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
  priority: string;
  estimated_hours: number | undefined;
  deadline: string;
  budget: string;
  objectives: string[];
  deliverables: string[];
  acceptance_criteria: string[];
  skill_requirements: string[];
}

const typeOptions = [
  { value: 'governance', label: 'Governance', icon: Scale },
  { value: 'technical', label: 'Technical', icon: Code2 },
  { value: 'cultural', label: 'Cultural', icon: Landmark },
  { value: 'community', label: 'Community', icon: Users },
];

const priorityOptions = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

function makeDefault(): ContributionForm {
  return {
    title: '',
    description: '',
    contribution_type: 'technical',
    priority: 'medium',
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
      form.value.contribution_type = c.contribution_type || 'technical';
      form.value.priority = c.priority || 'medium';
      form.value.estimated_hours = c.estimated_hours ?? undefined;
      form.value.deadline = c.deadline || '';
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
        priority: form.value.priority,
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
    priority: form.value.priority as 'low' | 'medium' | 'high' | 'critical',
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
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--matou-border);
}

// Type grid (2x2)
.type-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.type-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  background: transparent;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--matou-muted-foreground);
  transition: all 0.12s ease;
  text-align: left;

  &:hover {
    border-color: var(--matou-accent);
    color: var(--matou-foreground);
  }

  &.active {
    border-color: var(--matou-primary);
    background: rgba(30, 95, 116, 0.06);
    color: var(--matou-primary);
  }
}

.type-btn-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

// Priority grid (2x2)
.priority-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.priority-btn {
  padding: 8px 14px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  background: transparent;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-muted-foreground);
  transition: all 0.12s ease;
  text-transform: capitalize;

  &:hover {
    opacity: 0.85;
  }

  &.low.active {
    background: var(--matou-muted);
    color: var(--matou-muted-foreground);
    border-color: var(--matou-muted-foreground);
  }

  &.medium.active {
    background: rgba(74, 157, 156, 0.12);
    color: var(--matou-chart-2, #4a9d9c);
    border-color: var(--matou-chart-2, #4a9d9c);
  }

  &.high.active {
    background: rgba(30, 95, 116, 0.1);
    color: var(--matou-chart-1, #1e5f74);
    border-color: var(--matou-chart-1, #1e5f74);
  }

  &.critical.active {
    background: rgba(200, 70, 58, 0.1);
    color: var(--matou-destructive, #c8463a);
    border-color: var(--matou-destructive, #c8463a);
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
</style>
