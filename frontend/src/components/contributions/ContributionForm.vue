<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card style="min-width: 620px; max-width: 720px">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">{{ isEdit ? 'Edit Contribution' : 'Create Contribution' }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section class="q-gutter-md" style="max-height: 70vh; overflow-y: auto">
        <!-- Title -->
        <q-input v-model="form.title" label="Title *" outlined />

        <!-- Type + Priority -->
        <div class="row q-col-gutter-md">
          <div class="col-6">
            <q-select
              v-model="form.contribution_type"
              :options="typeOptions"
              label="Type *"
              outlined
              emit-value
              map-options
            />
          </div>
          <div class="col-6">
            <q-select
              v-model="form.priority"
              :options="priorityOptions"
              label="Priority *"
              outlined
              emit-value
              map-options
            />
          </div>
        </div>

        <!-- Description -->
        <q-input
          v-model="form.description"
          label="Description *"
          type="textarea"
          outlined
          autogrow
        />

        <!-- Project ID (required on create) -->
        <q-input
          v-if="!isEdit"
          v-model="form.project_id"
          label="Project ID *"
          outlined
          hint="The ID of the project this contribution belongs to"
        />

        <!-- Objectives -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Objectives</div>
          <div
            v-for="(_, i) in form.objectives"
            :key="i"
            class="row q-col-gutter-sm q-mb-sm"
          >
            <div class="col">
              <q-input
                v-model="form.objectives[i]"
                :label="`Objective ${i + 1}`"
                type="textarea"
                autogrow
                outlined
              />
            </div>
            <div class="col-auto">
              <q-btn
                flat
                round
                icon="remove_circle_outline"
                color="negative"
                @click="form.objectives.splice(i, 1)"
                :disable="form.objectives.length <= 1"
              />
            </div>
          </div>
          <q-btn
            flat
            size="sm"
            icon="add"
            label="Add Objective"
            color="primary"
            @click="form.objectives.push('')"
          />
        </div>

        <!-- Deliverables -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Deliverables</div>
          <div
            v-for="(_, i) in form.deliverables"
            :key="i"
            class="row q-col-gutter-sm q-mb-sm"
          >
            <div class="col">
              <q-input
                v-model="form.deliverables[i]"
                :label="`Deliverable ${i + 1}`"
                type="textarea"
                autogrow
                outlined
              />
            </div>
            <div class="col-auto">
              <q-btn
                flat
                round
                icon="remove_circle_outline"
                color="negative"
                @click="form.deliverables.splice(i, 1)"
                :disable="form.deliverables.length <= 1"
              />
            </div>
          </div>
          <q-btn
            flat
            size="sm"
            icon="add"
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
            class="row q-col-gutter-sm q-mb-sm"
          >
            <div class="col">
              <q-input
                v-model="form.acceptance_criteria[i]"
                :label="`Criterion ${i + 1}`"
                type="textarea"
                autogrow
                outlined
              />
            </div>
            <div class="col-auto">
              <q-btn
                flat
                round
                icon="remove_circle_outline"
                color="negative"
                @click="form.acceptance_criteria.splice(i, 1)"
                :disable="form.acceptance_criteria.length <= 1"
              />
            </div>
          </div>
          <q-btn
            flat
            size="sm"
            icon="add"
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
            class="row q-col-gutter-sm q-mb-sm"
          >
            <div class="col">
              <q-input
                v-model="form.skill_requirements[i]"
                :label="`Skill ${i + 1}`"
                outlined
                dense
              />
            </div>
            <div class="col-auto">
              <q-btn
                flat
                round
                icon="remove_circle_outline"
                color="negative"
                @click="form.skill_requirements.splice(i, 1)"
                :disable="form.skill_requirements.length <= 1"
              />
            </div>
          </div>
          <q-btn
            flat
            size="sm"
            icon="add"
            label="Add Skill"
            color="primary"
            @click="form.skill_requirements.push('')"
          />
        </div>

        <!-- Estimated Hours + Budget -->
        <div class="row q-col-gutter-md">
          <div class="col-6">
            <q-input
              v-model.number="form.estimated_duration"
              label="Estimated Hours"
              type="number"
              outlined
              min="0"
            />
          </div>
          <div class="col-6">
            <q-input v-model="form.budget" label="Budget" outlined />
          </div>
        </div>

        <!-- Unassign (edit mode + has assignee + status allowed + permission) -->
        <div
          v-if="canShowUnassign"
          class="unassign-block q-mt-sm"
        >
          <q-banner class="bg-yellow-1 q-mb-sm">
            <template #avatar>
              <q-icon name="person" color="warning" />
            </template>
            Currently assigned to <strong>{{ contribution?.assigned_contributor_id ?? (contribution as { assigned_contributor?: string })?.assigned_contributor }}</strong>
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
      </q-card-section>

      <!-- Danger Zone (edit mode only) -->
      <div v-if="isEdit && canDelete" class="danger-zone q-mx-md">
        <q-btn
          no-caps
          outline
          color="negative"
          icon="delete_forever"
          label="Delete Contribution"
          @click="$emit('delete')"
        />
      </div>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat label="Cancel" v-close-popup />
        <q-btn
          flat
          :label="isEdit ? 'Save Changes' : 'Create'"
          color="primary"
          @click="handleSubmit"
          :loading="submitting"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useQuasar } from 'quasar';
import type { Contribution, CreateContributionRequest, UpdateContributionRequest } from 'src/lib/api/contributions';

const $q = useQuasar();

interface ContributionFormData {
  project_id: string;
  title: string;
  description: string;
  contribution_type: string;
  priority: string;
  objectives: string[];
  deliverables: string[];
  acceptance_criteria: string[];
  skill_requirements: string[];
  estimated_duration: number | undefined;
  budget: string;
}

const props = defineProps<{
  modelValue: boolean;
  contribution?: Contribution | null;
  defaultProjectId?: string;
  canUnassign?: boolean;
  canDelete?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  submit: [form: CreateContributionRequest | UpdateContributionRequest];
  unassign: [];
  delete: [];
}>();

const typeOptions = [
  { label: 'Development', value: 'development' },
  { label: 'Design', value: 'design' },
  { label: 'Documentation', value: 'documentation' },
  { label: 'Research', value: 'research' },
  { label: 'Community', value: 'community' },
  { label: 'Operations', value: 'operations' },
  { label: 'Governance', value: 'governance' },
  { label: 'Other', value: 'other' },
];

const priorityOptions = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Critical', value: 'critical' },
];

const isEdit = ref(false);
const submitting = ref(false);

const canShowUnassign = computed(() => {
  if (!props.canUnassign) return false;
  if (!props.contribution) return false;
  const c = props.contribution;
  // Backend serialises assignee as `assigned_contributor` (json tag);
  // some clients also send `assigned_contributor_id`. Accept either.
  const assignee = c.assigned_contributor_id ?? (c as { assigned_contributor?: string }).assigned_contributor;
  if (!assignee) return false;
  return c.status === 'assigned';
});

function makeDefaultForm(): ContributionFormData {
  return {
    project_id: props.defaultProjectId ?? '',
    title: '',
    description: '',
    contribution_type: 'development',
    priority: 'medium',
    objectives: [''],
    deliverables: [''],
    acceptance_criteria: [''],
    skill_requirements: [''],
    estimated_duration: undefined,
    budget: '',
  };
}

const form = ref<ContributionFormData>(makeDefaultForm());

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;

    if (props.contribution) {
      isEdit.value = true;
      const c = props.contribution;
      form.value = {
        project_id: c.project_id,
        title: c.title,
        description: c.description,
        contribution_type: c.contribution_type,
        priority: c.priority,
        objectives: c.objectives?.length ? [...c.objectives] : [''],
        deliverables: c.deliverables?.length ? [...c.deliverables] : [''],
        acceptance_criteria: c.acceptance_criteria?.length ? [...c.acceptance_criteria] : [''],
        skill_requirements: c.skill_requirements?.length ? [...c.skill_requirements] : [''],
        estimated_duration: c.estimated_duration,
        budget: c.budget ?? '',
      };
    } else {
      isEdit.value = false;
      form.value = makeDefaultForm();
    }
  },
);

function handleSubmit() {
  const f = form.value;

  if (!f.title.trim()) {
    $q.notify({ type: 'negative', message: 'Title is required' });
    return;
  }
  if (!f.description.trim()) {
    $q.notify({ type: 'negative', message: 'Description is required' });
    return;
  }
  if (!isEdit.value && !f.project_id.trim()) {
    $q.notify({ type: 'negative', message: 'Project ID is required' });
    return;
  }
  if (!f.contribution_type) {
    $q.notify({ type: 'negative', message: 'Type is required' });
    return;
  }

  const objectives = f.objectives.filter(o => o.trim());
  const deliverables = f.deliverables.filter(d => d.trim());
  const acceptance_criteria = f.acceptance_criteria.filter(a => a.trim());
  const skill_requirements = f.skill_requirements.filter(s => s.trim());

  if (isEdit.value) {
    const req: UpdateContributionRequest = {
      title: f.title.trim(),
      description: f.description.trim(),
      priority: f.priority,
      objectives,
      deliverables,
      acceptance_criteria,
      skill_requirements,
      estimated_duration: f.estimated_duration,
      budget: f.budget.trim() || undefined,
    };
    emit('submit', req);
  } else {
    const req: CreateContributionRequest = {
      project_id: f.project_id.trim(),
      title: f.title.trim(),
      description: f.description.trim(),
      contribution_type: f.contribution_type,
      priority: f.priority as 'low' | 'medium' | 'high' | 'critical',
      objectives,
      deliverables,
      acceptance_criteria,
      skill_requirements,
      estimated_duration: f.estimated_duration,
      budget: f.budget.trim() || undefined,
      created_by: 'current-user',
    };
    emit('submit', req);
  }
}
</script>

<style scoped lang="scss">
.danger-zone {
  border-top: 1px solid var(--matou-border);
  padding-top: 16px;
  margin-top: 16px;
}

.danger-title {
  color: var(--matou-destructive);
  font-weight: 600;
}
</style>
