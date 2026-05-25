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

        <div>
          <div class="text-subtitle2 q-mb-sm">Type *</div>
          <div class="type-grid">
            <button
              v-for="opt in typeOptions"
              :key="opt.value"
              class="type-card"
              :class="{ active: form.type.includes(opt.value) }"
              @click="toggleType(opt.value)"
              type="button"
            >
              <q-icon :name="opt.icon" size="24px" />
              <span>{{ opt.label }}</span>
            </button>
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

        <!-- Attachments: URLs + File Uploads -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Attachments</div>

          <!-- URL links -->
          <div class="attachment-url-row q-mb-sm">
            <q-input
              v-model="newAttachmentUrl"
              outlined
              dense
              placeholder="https://..."
              class="attachment-url-input"
            />
            <q-btn
              unelevated
              no-caps
              icon="link"
              label="Add Link"
              color="primary"
              class="attachment-add-btn"
              :disable="!newAttachmentUrl.trim()"
              @click="addUrlAttachment"
            />
          </div>

          <!-- Attached items (URLs + files) -->
          <div class="attachment-thumbs-row">
            <div
              v-for="(att, i) in form.attachments"
              :key="i"
              class="attachment-thumb"
            >
              <q-icon :name="att.file_ref ? fileIcon(att.type || '') : 'link'" size="24px" class="attachment-thumb-icon" />
              <div class="attachment-thumb-name">{{ att.name }}</div>
              <q-btn flat round dense icon="close" size="xs" class="attachment-thumb-remove" @click="form.attachments.splice(i, 1)" />
            </div>
            <button class="attachment-add-file-btn" :disabled="uploadingFile" @click="fileInput?.click()">
              <q-spinner-dots v-if="uploadingFile" size="20px" />
              <q-icon v-else name="upload_file" size="24px" />
              <span>{{ uploadingFile ? 'Uploading...' : 'Upload' }}</span>
            </button>
            <input
              ref="fileInput"
              type="file"
              multiple
              style="display: none"
              @change="handleFileUpload"
            />
          </div>
        </div>

        <q-btn
          v-if="canWithdraw"
          outline
          no-caps
          icon="undo"
          color="negative"
          label="Withdraw Proposal"
          class="full-width q-mt-md"
          @click="$emit('withdraw')"
        />
      </q-card-section>

      <div class="dialog-footer">
        <q-btn
          no-caps
          :label="isEdit ? 'Save Changes' : 'Create Proposal'"
          color="primary"
          class="dialog-footer-btn"
          @click="handleSubmit"
          :loading="submitting"
        />
        <q-btn outline no-caps label="Cancel" color="primary" class="dialog-footer-btn" v-close-popup />
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useQuasar } from 'quasar';
import type { Proposal } from 'src/lib/api/proposals';
import { uploadFile, getFileUrl } from 'src/lib/api/client';
import { useIdentityStore } from 'stores/identity';

const $q = useQuasar();
const identityStore = useIdentityStore();

interface ProposalFormData {
  title: string;
  type: string[];
  description: string;
  problem_statement: string;
  solution: string;
  expected_outcomes: string[];
  estimated_budget: string;
  timeline: string;
  attachments: { name: string; url: string; type?: string; file_ref?: string }[];
}

const props = defineProps<{
  modelValue: boolean;
  proposal?: Proposal | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  submit: [form: ProposalFormData];
  withdraw: [];
}>();

const WITHDRAWABLE_STATUSES = ['draft', 'submitted', 'endorsing', 'in_review'];
const canWithdraw = computed(() => {
  const p = props.proposal;
  if (!p) return false;
  if (!WITHDRAWABLE_STATUSES.includes(p.status)) return false;
  const aid = identityStore.currentAID;
  const isProposer = !!aid && (p.proposer_id === aid.name || p.proposer_id === aid.prefix);
  return isProposer || identityStore.isAdmin;
});

const typeOptions = [
  { label: 'Technical', value: 'technical', icon: 'code' },
  { label: 'Community', value: 'community', icon: 'groups' },
  { label: 'Governance', value: 'governance', icon: 'gavel' },
  { label: 'Operations', value: 'operations', icon: 'settings' },
];

const isEdit = ref(false);
const submitting = ref(false);
const newAttachmentUrl = ref('');
const uploadingFile = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function fileIcon(mimeType: string): string {
  if (mimeType.includes('pdf')) return 'picture_as_pdf';
  if (mimeType.includes('spreadsheet') || mimeType.includes('csv')) return 'table_chart';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'article';
  if (mimeType.startsWith('image/')) return 'image';
  return 'description';
}

function addUrlAttachment() {
  const url = newAttachmentUrl.value.trim();
  if (!url) return;
  // Extract name from URL
  const name = url.split('/').pop()?.split('?')[0] || url;
  form.value.attachments.push({ name, url });
  newAttachmentUrl.value = '';
}

async function handleFileUpload(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files?.length) return;
  uploadingFile.value = true;
  try {
    for (const file of Array.from(files)) {
      const result = await uploadFile(file);
      if (result.fileRef) {
        form.value.attachments.push({
          name: file.name,
          url: getFileUrl(result.fileRef),
          type: file.type,
          file_ref: result.fileRef,
        });
      } else {
        $q.notify({ type: 'negative', message: result.error || `Failed to upload ${file.name}` });
      }
    }
  } finally {
    uploadingFile.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

function toggleType(value: string) {
  const idx = form.value.type.indexOf(value);
  if (idx >= 0) {
    form.value.type.splice(idx, 1);
  } else {
    form.value.type.push(value);
  }
}

function makeDefaultForm(): ProposalFormData {
  return {
    title: '',
    type: [],
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

  const attachments = f.attachments.filter((a) => a.name.trim() && (a.url.trim() || a.file_ref));

  emit('submit', { ...f, expected_outcomes: outcomes, attachments });
}
</script>

<style scoped>
.form-fields {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.type-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.type-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 8px;
  border: 2px solid var(--matou-border, #e5e7eb);
  border-radius: 10px;
  background: transparent;
  color: var(--matou-muted-foreground, #6b7280);
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
  transition: all 0.15s ease;

  &:hover {
    border-color: var(--matou-teal, #0d9488);
    color: var(--matou-teal, #0d9488);
  }

  &.active {
    border-color: var(--matou-teal, #0d9488);
    background: var(--matou-teal, #0d9488);
    color: white;
  }
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

.attachment-url-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.attachment-url-input {
  flex: 1;
}

.attachment-add-btn {
  border-radius: 10px;
}

.attachment-thumbs-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-start;
}

.attachment-thumb {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 80px;
  padding: 8px 4px 6px;
  border: 1px solid var(--matou-border);
  border-radius: 6px;
  background: var(--matou-secondary);
  overflow: hidden;
}

.attachment-thumb-icon {
  color: var(--matou-muted-foreground);
  margin-bottom: 2px;
}

.attachment-thumb-name {
  font-size: 0.65rem;
  color: var(--matou-muted-foreground);
  text-align: center;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 4px;
}

.attachment-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
}

.attachment-add-file-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 80px;
  height: 80px;
  border: 1px dashed var(--matou-border);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  font-size: 0.7rem;
  transition: all 0.12s ease;

  &:hover {
    border-color: var(--matou-primary);
    color: var(--matou-primary);
  }
}
</style>
