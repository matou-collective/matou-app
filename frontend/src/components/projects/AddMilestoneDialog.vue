<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card class="milestone-dialog">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">Add Milestone</div>
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

        <div class="row q-col-gutter-md">
          <div class="col-6">
            <q-input
              v-model="form.start_date"
              label="Start Date"
              type="date"
              outlined
            />
          </div>
          <div class="col-6">
            <q-input
              v-model="form.end_date"
              label="End Date"
              type="date"
              outlined
            />
          </div>
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

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat no-caps label="Cancel" v-close-popup @click="resetForm" />
        <q-btn
          no-caps
          label="Add Milestone"
          color="primary"
          :loading="isSubmitting"
          :disable="!isValid"
          @click="handleSubmit"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { CreateMilestoneRequest } from 'src/types/projects';

interface Props {
  modelValue: boolean;
  projectId: string;
  implementationPlanId: string;
  isSubmitting?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isSubmitting: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'submit', req: CreateMilestoneRequest): void;
}>();

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
  () => props.modelValue,
  (open) => {
    if (!open) resetForm();
  },
);

function resetForm() {
  form.value = makeDefault();
}

function handleSubmit() {
  if (!isValid.value) return;
  const req: CreateMilestoneRequest = {
    title: form.value.title.trim(),
    description: form.value.description.trim() || undefined,
    duration: form.value.duration.trim(),
    start_date: form.value.start_date || undefined,
    end_date: form.value.end_date || undefined,
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
</style>
