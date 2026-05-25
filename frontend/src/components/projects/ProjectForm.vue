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

        <!-- Banner image -->
        <div class="image-upload">
          <div class="image-upload-label">Banner image</div>
          <div v-if="form.image_url" class="image-preview-wrap">
            <img :src="form.image_url" class="image-preview" alt="Project banner" />
            <q-btn
              flat
              dense
              round
              icon="close"
              class="image-remove-btn"
              aria-label="Remove image"
              @click="removeImage"
            />
          </div>
          <button
            v-else
            type="button"
            class="image-upload-btn"
            :disabled="uploadingImage"
            @click="imageInput?.click()"
          >
            <q-spinner-dots v-if="uploadingImage" size="20px" />
            <q-icon v-else name="image" size="20px" />
            <span>{{ uploadingImage ? 'Uploading...' : 'Upload image' }}</span>
          </button>
          <input
            ref="imageInput"
            type="file"
            accept="image/*"
            style="display: none"
            @change="onImageSelected"
          />
        </div>

        <div class="inline-row">
          <q-input
            v-model="form.budget"
            label="Estimated budget"
            outlined
            placeholder="e.g. $5,000"
          />
          <q-input
            v-model="form.duration"
            label="Estimated duration"
            outlined
            placeholder="e.g. 8 weeks"
          />
        </div>

        <div class="inline-row">
          <q-input
            v-model="form.start_date"
            label="Start date"
            outlined
            type="date"
            stack-label
          />
          <q-input
            v-model="form.end_date"
            label="End date"
            outlined
            type="date"
            stack-label
          />
        </div>

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

        <!-- Danger Zone (edit mode only) -->
        <div v-if="isEdit && canDelete" class="danger-zone q-mt-md">
          <q-btn
            no-caps
            outline
            color="negative"
            icon="delete_forever"
            label="Delete Project"
            class="full-width"
            @click="$emit('delete')"
          />
        </div>
      </q-card-section>

      <q-card-section class="form-error" v-if="submitError">
        <q-icon name="error" color="negative" size="16px" />
        <span>{{ submitError }}</span>
      </q-card-section>

      <div class="project-form-actions q-px-md q-pb-md">
        <q-btn
          no-caps
          :label="isEdit ? 'Save Changes' : 'Create Project'"
          color="primary"
          class="project-form-btn"
          :loading="isSubmitting"
          :disable="!isFormValid"
          @click="handleSubmit"
        />
        <q-btn outline no-caps label="Cancel" color="primary" class="project-form-btn" v-close-popup @click="resetForm" />
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useQuasar } from 'quasar';
import { Vote } from 'lucide-vue-next';
import type { Project, ProjectImage } from 'src/lib/api/projects';
import type { Proposal } from 'src/lib/api/proposals';
import { uploadFile, getFileUrl } from 'src/lib/api/client';
import { useIdentityStore } from 'stores/identity';

const $q = useQuasar();
const identityStore = useIdentityStore();

interface Props {
  modelValue: boolean;
  project?: Project | null;
  isSubmitting?: boolean;
  submitError?: string | null;
  availableProposals?: Proposal[];
  linking?: boolean;
  canDelete?: boolean;
  prefill?: { title?: string; description?: string } | null;
}

const props = withDefaults(defineProps<Props>(), {
  project: null,
  isSubmitting: false,
  submitError: null,
  availableProposals: () => [],
  linking: false,
  canDelete: false,
  prefill: null,
});

export interface ProjectFormSubmit {
  title: string;
  description: string;
  budget?: string;
  duration?: string;
  start_date?: string;
  end_date?: string;
  images?: ProjectImage[];
}

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'submit', data: ProjectFormSubmit): void;
  (e: 'link-proposal', proposalId: string): void;
  (e: 'delete'): void;
}>();

const isEdit = computed(() => !!props.project);

const form = ref({
  title: '',
  description: '',
  budget: '',
  duration: '',
  start_date: '',
  end_date: '',
  image_url: '',
  image_id: '',
});

const imageInput = ref<HTMLInputElement | null>(null);
const uploadingImage = ref(false);

async function onImageSelected(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  uploadingImage.value = true;
  try {
    const result = await uploadFile(file);
    if (result.fileRef) {
      form.value.image_url = getFileUrl(result.fileRef);
      form.value.image_id = result.fileRef;
    } else {
      $q.notify({ type: 'negative', message: result.error || 'Upload failed' });
    }
  } finally {
    uploadingImage.value = false;
    target.value = '';
  }
}

function removeImage() {
  form.value.image_url = '';
  form.value.image_id = '';
}

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
      const banner = (proj.images ?? []).find(img => img.type === 'banner');
      form.value.title = proj.title;
      form.value.description = proj.description;
      form.value.budget = proj.budget ?? '';
      form.value.duration = proj.duration ?? '';
      form.value.start_date = proj.start_date ?? '';
      form.value.end_date = proj.end_date ?? '';
      form.value.image_url = banner?.url ?? '';
      form.value.image_id = banner?.image_id ?? '';
    } else {
      resetForm();
    }
  },
  { immediate: true },
);

// Reset when dialog closes; apply prefill (create mode) when it opens
watch(
  () => props.modelValue,
  (open) => {
    if (open && !props.project && props.prefill) {
      form.value = {
        title: props.prefill.title ?? '',
        description: props.prefill.description ?? '',
        budget: '',
        duration: '',
        start_date: '',
        end_date: '',
        image_url: '',
        image_id: '',
      };
    }
    if (!open) resetForm();
  },
);

function resetForm() {
  if (!props.project) {
    form.value = {
      title: '',
      description: '',
      budget: '',
      duration: '',
      start_date: '',
      end_date: '',
      image_url: '',
      image_id: '',
    };
  }
  selectedProposalId.value = null;
}

function getProposalTitle(pid: string): string {
  const found = props.availableProposals.find(p => p.id === pid);
  return found ? found.title : pid;
}

function handleSubmit() {
  if (!isFormValid.value) return;
  const me = identityStore.aidPrefix ?? '';
  const existingImages = props.project?.images ?? [];
  const nonBanner = existingImages.filter(img => img.type !== 'banner');
  let images: ProjectImage[] | undefined;
  if (form.value.image_url) {
    const existingBanner = existingImages.find(img => img.type === 'banner' && img.image_id === form.value.image_id);
    const banner: ProjectImage = existingBanner ?? {
      image_id: form.value.image_id,
      url: form.value.image_url,
      type: 'banner',
      uploaded_at: new Date().toISOString(),
      uploaded_by: me,
    };
    images = [...nonBanner, banner];
  } else if (existingImages.some(img => img.type === 'banner')) {
    images = nonBanner;
  }
  emit('submit', {
    title: form.value.title.trim(),
    description: form.value.description.trim(),
    budget: form.value.budget.trim() || undefined,
    duration: form.value.duration.trim() || undefined,
    start_date: form.value.start_date || undefined,
    end_date: form.value.end_date || undefined,
    images,
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

.project-form-actions {
  display: flex;
  gap: 8px;
}

.project-form-btn {
  flex: 1;
}

.danger-zone {
  border-top: 1px solid var(--matou-border);
  padding-top: 16px;
  margin-top: 16px;
}

.danger-title {
  color: var(--matou-destructive);
  font-weight: 600;
}

.inline-row {
  display: flex;
  gap: 16px;

  > * {
    flex: 1;
  }
}

.image-upload-label {
  font-size: 0.85rem;
  color: var(--matou-muted-foreground);
  margin-bottom: 6px;
}

.image-preview-wrap {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
}

.image-preview {
  width: 100%;
  height: 160px;
  object-fit: cover;
  display: block;
}

.image-remove-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: white;
}

.image-upload-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 14px;
  background: transparent;
  border: 1px dashed var(--matou-border);
  border-radius: 10px;
  color: var(--matou-muted-foreground);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.image-upload-btn:hover:not(:disabled) {
  border-color: var(--matou-primary);
  color: var(--matou-primary);
}

.image-upload-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
