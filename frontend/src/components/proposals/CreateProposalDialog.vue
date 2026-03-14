<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card style="min-width: 600px; max-width: 700px">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">{{ isEdit ? 'Edit Proposal' : 'Create Proposal' }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section class="form-fields" style="max-height: 70vh; overflow-y: auto">
        <q-input v-model="form.title" label="Title *" outlined />

        <div class="row q-col-gutter-md">
          <div class="col-12 col-sm-6">
            <q-select
              v-model="form.type"
              :options="typeOptions"
              label="Type *"
              outlined
              multiple
              use-chips
              emit-value
              map-options
              @update:model-value="closeTypeSelect"
              ref="typeSelectRef"
            />
          </div>
          <div class="col-12 col-sm-6">
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

        <q-input v-model="form.description" label="Description *" type="textarea" outlined autogrow />
        <q-input
          v-model="form.problem_statement"
          label="Problem Statement *"
          type="textarea"
          outlined
          autogrow
        />
        <q-input
          v-model="form.solution"
          label="Proposed Solution *"
          type="textarea"
          outlined
          autogrow
        />

        <!-- Expected Outcomes -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Expected Outcomes *</div>
          <div
            v-for="(_, i) in form.expected_outcomes"
            :key="i"
            class="row q-col-gutter-sm q-mb-sm"
          >
            <div class="col">
              <q-input
                v-model="form.expected_outcomes[i]"
                :label="`Outcome ${i + 1}`"
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
                @click="form.expected_outcomes.splice(i, 1)"
                :disable="form.expected_outcomes.length <= 1"
              />
            </div>
          </div>
          <q-btn
            flat
            size="sm"
            icon="add"
            label="Add Outcome"
            color="primary"
            @click="form.expected_outcomes.push('')"
          />
        </div>

        <div class="row q-col-gutter-md">
          <div class="col-12 col-sm-6">
            <q-input
              v-model="form.estimated_budget"
              label="Estimated Budget *"
              outlined
              type="number"
              :rules="[val => !!val || 'Required', val => /^\d+$/.test(val) || 'Must be a whole number']"
            />
          </div>
          <div class="col-12 col-sm-6">
            <q-input
              v-model="form.timeline"
              label="Timeline (months) *"
              outlined
              type="number"
              :rules="[val => !!val || 'Required', val => /^\d+$/.test(val) || 'Must be a whole number']"
            />
          </div>
        </div>

        <!-- Attachments -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Attachments</div>
          <div
            v-for="(_, i) in form.attachments"
            :key="i"
            class="row q-col-gutter-sm q-mb-sm"
          >
            <div class="col-5">
              <q-input v-model="form.attachments[i].name" label="Name" outlined dense />
            </div>
            <div class="col">
              <q-input v-model="form.attachments[i].url" label="URL" outlined dense />
            </div>
            <div class="col-auto">
              <q-btn
                flat
                round
                icon="remove_circle_outline"
                color="negative"
                @click="form.attachments.splice(i, 1)"
              />
            </div>
          </div>
          <q-btn
            flat
            size="sm"
            icon="attach_file"
            label="Add Attachment"
            color="primary"
            @click="form.attachments.push({ name: '', url: '' })"
          />
        </div>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat label="Cancel" v-close-popup />
        <q-btn
          flat
          label="Save"
          color="primary"
          @click="handleSubmit"
          :loading="submitting"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import type { Proposal } from 'src/lib/api/proposals';

const $q = useQuasar();

interface ProposalFormData {
  title: string;
  type: string[];
  priority: string;
  description: string;
  problem_statement: string;
  solution: string;
  expected_outcomes: string[];
  estimated_budget: string;
  timeline: string;
  attachments: { name: string; url: string }[];
}

const props = defineProps<{
  modelValue: boolean;
  proposal?: Proposal | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  submit: [form: ProposalFormData];
}>();

const typeOptions = [
  { label: 'Technical', value: 'technical' },
  { label: 'Community', value: 'community' },
  { label: 'Governance', value: 'governance' },
  { label: 'Operations', value: 'operations' },
];

const priorityOptions = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Critical', value: 'critical' },
];

const isEdit = ref(false);
const submitting = ref(false);
const typeSelectRef = ref<InstanceType<typeof import('quasar').QSelect> | null>(null);

function closeTypeSelect() {
  typeSelectRef.value?.hidePopup();
}

function makeDefaultForm(): ProposalFormData {
  return {
    title: '',
    type: [],
    priority: 'medium',
    description: '',
    problem_statement: '',
    solution: '',
    expected_outcomes: [''],
    estimated_budget: '',
    timeline: '',
    attachments: [],
  };
}

const form = ref<ProposalFormData>(makeDefaultForm());

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;

    if (props.proposal) {
      isEdit.value = true;
      const p = props.proposal;
      form.value = {
        title: p.title,
        type: p.type ? [...p.type] : [],
        priority: p.priority,
        description: p.description,
        problem_statement: p.problem_statement,
        solution: p.solution,
        expected_outcomes: p.expected_outcomes?.length ? [...p.expected_outcomes] : [''],
        estimated_budget: p.estimated_budget,
        timeline: p.timeline,
        attachments: p.attachments ? p.attachments.map((a) => ({ ...a })) : [],
      };
    } else {
      isEdit.value = false;
      form.value = makeDefaultForm();
    }
  },
);

function handleSubmit() {
  const f = form.value;

  if (!f.title || !f.description || !f.problem_statement || !f.solution || !f.estimated_budget || !f.timeline) {
    $q.notify({ type: 'negative', message: 'Please fill in all required fields' });
    return;
  }
  if (f.type.length === 0) {
    $q.notify({ type: 'negative', message: 'Please select at least one type' });
    return;
  }

  const outcomes = f.expected_outcomes.filter((o) => o.trim());
  if (outcomes.length === 0) {
    $q.notify({ type: 'negative', message: 'Please add at least one expected outcome' });
    return;
  }

  const attachments = f.attachments.filter((a) => a.name.trim() && a.url.trim());

  emit('submit', { ...f, expected_outcomes: outcomes, attachments });
}
</script>

<style scoped>
.form-fields {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
