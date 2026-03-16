<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card style="min-width: 560px; max-width: 640px">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">{{ isEdit ? 'Edit Project' : 'Create Project' }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup @click="resetForm" />
      </q-card-section>

      <q-card-section class="q-gutter-md" style="max-height: 70vh; overflow-y: auto">
        <q-input
          v-model="form.title"
          label="Title *"
          outlined
          :rules="[val => !!val.trim() || 'Title is required']"
        />

        <q-input
          v-model="form.description"
          label="Description *"
          type="textarea"
          outlined
          autogrow
          :rules="[val => !!val.trim() || 'Description is required']"
        />

        <!-- Linked proposals section (edit mode only) -->
        <div v-if="isEdit && availableProposals.length > 0">
          <div class="text-subtitle2 q-mb-sm">Link Proposal</div>
          <q-select
            v-model="selectedProposalId"
            :options="proposalOptions"
            label="Link a proposal to this project"
            outlined
            clearable
            emit-value
            map-options
          />
          <q-btn
            v-if="selectedProposalId"
            flat
            no-caps
            dense
            label="Link Proposal"
            color="primary"
            class="q-mt-sm"
            :loading="linking"
            @click="handleLinkProposal"
          />
        </div>

        <!-- Already linked proposals -->
        <div v-if="linkedProposals.length > 0">
          <div class="text-subtitle2 q-mb-sm">Linked Proposals</div>
          <div class="linked-list">
            <div
              v-for="pid in linkedProposals"
              :key="pid"
              class="linked-item"
            >
              <Vote class="linked-icon" />
              <span>{{ getProposalTitle(pid) }}</span>
            </div>
          </div>
        </div>
      </q-card-section>

      <q-card-section class="form-error" v-if="submitError">
        <q-icon name="error" color="negative" size="16px" />
        <span>{{ submitError }}</span>
      </q-card-section>

      <q-card-actions align="right" class="q-pt-none q-px-md q-pb-md">
        <q-btn flat no-caps label="Cancel" v-close-popup @click="resetForm" />
        <q-btn
          no-caps
          :label="isEdit ? 'Save Changes' : 'Create Project'"
          color="primary"
          :loading="isSubmitting"
          :disable="!isFormValid"
          @click="handleSubmit"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { Vote } from 'lucide-vue-next';
import type { Project } from 'src/lib/api/projects';
import type { Proposal } from 'src/lib/api/proposals';

interface Props {
  modelValue: boolean;
  project?: Project | null;
  isSubmitting?: boolean;
  submitError?: string | null;
  availableProposals?: Proposal[];
  linking?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  project: null,
  isSubmitting: false,
  submitError: null,
  availableProposals: () => [],
  linking: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'submit', data: { title: string; description: string }): void;
  (e: 'link-proposal', proposalId: string): void;
}>();

const isEdit = computed(() => !!props.project);

const form = ref({
  title: '',
  description: '',
});

const selectedProposalId = ref<string | null>(null);

const linkedProposals = computed(() => props.project?.proposal_ids ?? []);

const proposalOptions = computed(() =>
  props.availableProposals
    .filter(p => !linkedProposals.value.includes(p.id))
    .map(p => ({ label: p.title, value: p.id })),
);

const isFormValid = computed(
  () => form.value.title.trim().length > 0 && form.value.description.trim().length > 0,
);

// Sync form with project prop when editing
watch(
  () => props.project,
  (proj) => {
    if (proj) {
      form.value.title = proj.title;
      form.value.description = proj.description;
    } else {
      resetForm();
    }
  },
  { immediate: true },
);

// Reset when dialog closes
watch(
  () => props.modelValue,
  (open) => {
    if (!open) resetForm();
  },
);

function resetForm() {
  if (!props.project) {
    form.value = { title: '', description: '' };
  }
  selectedProposalId.value = null;
}

function getProposalTitle(pid: string): string {
  const found = props.availableProposals.find(p => p.id === pid);
  return found ? found.title : pid;
}

function handleSubmit() {
  if (!isFormValid.value) return;
  emit('submit', {
    title: form.value.title.trim(),
    description: form.value.description.trim(),
  });
}

function handleLinkProposal() {
  if (!selectedProposalId.value) return;
  emit('link-proposal', selectedProposalId.value);
  selectedProposalId.value = null;
}
</script>

<style scoped lang="scss">
.form-error {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--matou-destructive);
  font-size: 0.85rem;
  padding-top: 0;
}

.linked-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.linked-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  font-size: 0.875rem;
  color: var(--matou-foreground);
}

.linked-icon {
  width: 14px;
  height: 14px;
  color: var(--matou-primary);
  flex-shrink: 0;
}
</style>
