<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card class="milestone-dialog">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">{{ isEdit ? 'Edit Milestone' : 'Add Milestone' }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup @click="resetForm" />
      </q-card-section>

      <q-card-section class="q-gutter-md form-body">
        <q-input
          v-model="form.title"
          label="Milestone Title *"
          outlined
          :rules="[(v) => !!v.trim() || 'Title is required']"
          @keydown.enter.prevent
        />

        <q-input
          v-model="form.description"
          label="Description"
          type="textarea"
          outlined
          autogrow
        />

        <q-input
          v-model="form.duration"
          label="Duration *"
          outlined
          placeholder="e.g. 4 weeks, 2 months"
          hint="Estimated time to complete this milestone"
          :rules="[(v) => !!v.trim() || 'Duration is required']"
        />

        <div class="date-row">
          <q-input
            v-model="form.start_date"
            label="Start Date"
            outlined
            mask="##-##-####"
            placeholder="dd-mm-yyyy"
          >
            <template #append>
              <q-icon name="event" class="cursor-pointer">
                <q-popup-proxy cover transition-show="scale" transition-hide="scale">
                  <q-date
                    :model-value="toQDateFormat(form.start_date)"
                    @update:model-value="form.start_date = fromQDateFormat($event)"
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
          <q-input
            v-model="form.end_date"
            label="End Date"
            outlined
            mask="##-##-####"
            placeholder="dd-mm-yyyy"
          >
            <template #append>
              <q-icon name="event" class="cursor-pointer">
                <q-popup-proxy cover transition-show="scale" transition-hide="scale">
                  <q-date
                    :model-value="toQDateFormat(form.end_date)"
                    @update:model-value="form.end_date = fromQDateFormat($event)"
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

        <!-- Success criteria -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Success Criteria</div>
          <div
            v-for="(_, i) in form.success_criteria"
            :key="i"
            class="row q-col-gutter-sm q-mb-sm"
          >
            <div class="col">
              <q-input
                v-model="form.success_criteria[i]"
                :label="`Criterion ${i + 1}`"
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
                @click="form.success_criteria.splice(i, 1)"
                :disable="form.success_criteria.length <= 1"
              />
            </div>
          </div>
          <q-btn
            flat
            size="sm"
            icon="add"
            no-caps
            label="Add Criterion"
            color="primary"
            @click="form.success_criteria.push('')"
          />
        </div>
      </q-card-section>

      <div class="milestone-actions q-px-md q-pb-md">
        <q-btn
          no-caps
          :label="isEdit ? 'Save Changes' : 'Add Milestone'"
          color="primary"
          class="milestone-action-btn"
          :loading="isSubmitting"
          :disable="!isValid"
          @click="handleSubmit"
        />
        <q-btn outline no-caps label="Cancel" color="primary" class="milestone-action-btn" v-close-popup @click="resetForm" />
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
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

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'submit', req: CreateMilestoneRequest | UpdateMilestoneRequest): void;
}>();

const isEdit = computed(() => !!props.milestone);

interface MilestoneForm {
  title: string;
  description: string;
  duration: string;
  start_date: string;
  end_date: string;
  success_criteria: string[];
}

function makeDefault(): MilestoneForm {
  return {
    title: '',
    description: '',
    duration: '',
    start_date: '',
    end_date: '',
    success_criteria: [''],
  };
}

const form = ref<MilestoneForm>(makeDefault());

const isValid = computed(
  () => form.value.title.trim().length > 0 && form.value.duration.trim().length > 0,
);

watch(
  () => [props.modelValue, props.milestone] as const,
  ([open, ms]) => {
    if (!open) {
      resetForm();
      return;
    }
    if (ms) {
      form.value = {
        title: ms.title,
        description: ms.description ?? '',
        duration: ms.duration,
        start_date: ms.start_date ? fromISODate(ms.start_date) : '',
        end_date: ms.end_date ? fromISODate(ms.end_date) : '',
        success_criteria: ms.success_criteria?.length ? [...ms.success_criteria] : [''],
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

function resetForm() {
  form.value = makeDefault();
}

function handleSubmit() {
  if (!isValid.value) return;
  const req: CreateMilestoneRequest = {
    title: form.value.title.trim(),
    description: form.value.description.trim() || undefined,
    duration: form.value.duration.trim(),
    start_date: toISODate(form.value.start_date) || undefined,
    end_date: toISODate(form.value.end_date) || undefined,
    success_criteria: form.value.success_criteria.filter((c) => c.trim()),
  };
  emit('submit', req);
}
</script>

<style scoped lang="scss">
.milestone-dialog {
  min-width: 500px;
  max-width: 620px;
}

.form-body {
  max-height: 65vh;
  overflow-y: auto;
}

.milestone-actions {
  display: flex;
  gap: 8px;
}

.milestone-action-btn {
  flex: 1;
  border-radius: 10px;
}

.date-row {
  display: flex;
  gap: 16px;

  > * {
    flex: 1;
  }
}
</style>
