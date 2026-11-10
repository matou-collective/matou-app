<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="onDialogToggle"
  >
    <q-card class="report-dialog">
      <q-card-section class="row items-center q-pb-none">
        <q-icon :name="copy.icon" color="primary" size="24px" />
        <div class="text-h6 q-ml-sm">{{ copy.heading }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <!-- Success state -->
      <template v-if="result">
        <q-card-section>
          <p class="success-text">Thanks — logged as {{ copy.logged }} #{{ result.number }}.</p>
          <p v-if="result.html_url" class="issue-url">{{ result.html_url }}</p>
        </q-card-section>
        <div class="dialog-footer">
          <q-btn
            outline
            no-caps
            color="primary"
            label="Close"
            class="dialog-footer-btn"
            v-close-popup
          />
        </div>
      </template>

      <!-- Form state -->
      <template v-else>
        <q-card-section>
          <div v-if="errorMessage" class="error-banner">{{ errorMessage }}</div>

          <q-input
            v-model="title"
            label="Title"
            outlined
            dense
            :maxlength="TITLE_MAX"
            class="q-mb-md"
          />

          <q-input
            v-model="description"
            type="textarea"
            label="Description"
            outlined
            rows="5"
            :maxlength="DESCRIPTION_MAX"
            :placeholder="copy.placeholder"
          />

          <div class="context-preview">
            <div class="context-preview-title">Included with your report</div>
            <div>App version {{ context.appVersion }} · {{ context.env }}</div>
            <div>{{ context.platform }}</div>
            <div>Reported by {{ context.reporter }}</div>
          </div>
        </q-card-section>

        <div class="dialog-footer">
          <q-btn
            color="primary"
            no-caps
            unelevated
            label="Submit"
            class="dialog-footer-btn"
            :loading="submitting"
            :disable="!canSubmit"
            @click="onSubmit"
          />
          <q-btn
            outline
            no-caps
            color="primary"
            label="Cancel"
            class="dialog-footer-btn"
            v-close-popup
          />
        </div>
      </template>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  buildIssuePayload,
  DESCRIPTION_MAX,
  TITLE_MAX,
  type IssueType,
} from 'src/lib/issueReport';
import {
  collectIssueContext,
  IssueSubmitError,
  submitIssue,
  type IssueResult,
} from 'src/lib/api/issues';
import { KIT } from 'src/generated/kit';

// One dialog, two doors: "Report an issue" opens it as a bug, "Suggest an
// improvement" as an improvement. The type is fixed by the door, not toggled.
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    reporterName: string;
    type?: IssueType;
  }>(),
  { type: 'bug' },
);

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const COPY: Record<IssueType, { heading: string; icon: string; logged: string; placeholder: string }> = {
  bug: {
    heading: 'Report an issue',
    icon: 'bug_report',
    logged: 'issue',
    placeholder: 'What happened? What did you expect to happen?',
  },
  improvement: {
    heading: 'Suggest an improvement',
    icon: 'lightbulb',
    logged: 'suggestion',
    placeholder: 'What would you like to see?',
  },
};

const copy = computed(() => COPY[props.type]);

// Each door keeps its own draft, so switching doors never mixes a half-written
// bug report into a suggestion.
const drafts: Record<IssueType, { title: string; description: string }> = {
  bug: { title: '', description: '' },
  improvement: { title: '', description: '' },
};
const title = ref('');
const description = ref('');
const submitting = ref(false);
const errorMessage = ref('');
const result = ref<IssueResult | null>(null);

const context = computed(() => collectIssueContext(props.reporterName));

const canSubmit = computed(
  () => title.value.trim().length > 0 && description.value.trim().length > 0 && !submitting.value,
);

// Clear stale transient state on open. Field values survive close/reopen so a
// draft can be resumed — they only reset after a successful submit.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      drafts[props.type] = { title: title.value, description: description.value };
      return;
    }
    if (result.value) {
      result.value = null;
    }
    title.value = drafts[props.type].title;
    description.value = drafts[props.type].description;
    errorMessage.value = '';
    submitting.value = false;
  },
);

function onDialogToggle(value: boolean) {
  emit('update:modelValue', value);
}

const ERROR_COPY: Record<string, string> = {
  unreachable: `Couldn't reach the issue service. Check your connection, or email ${KIT.brand.contactEmail}.`,
  rate_limited: 'Too many reports right now — please try again in a minute.',
  invalid: 'Something was wrong with the report. Please check the fields and try again.',
  server: `The issue couldn't be created. Please try again later or email ${KIT.brand.contactEmail}.`,
};

async function onSubmit() {
  errorMessage.value = '';
  submitting.value = true;
  try {
    const payload = buildIssuePayload(
      { type: props.type, title: title.value, description: description.value },
      context.value,
    );
    result.value = await submitIssue(payload);
    drafts[props.type] = { title: '', description: '' };
    title.value = '';
    description.value = '';
  } catch (err) {
    errorMessage.value =
      err instanceof IssueSubmitError
        ? ERROR_COPY[err.code]
        : ERROR_COPY.server;
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped lang="scss">
.report-dialog {
  min-width: 525px;
  max-width: 650px;
}

.error-banner {
  background: rgba(220, 53, 69, 0.08);
  color: var(--matou-destructive, #dc3545);
  border: 1px solid rgba(220, 53, 69, 0.3);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
}

.context-preview {
  margin-top: 1rem;
  padding: 0.625rem 0.75rem;
  border: 1px dashed var(--matou-border, #ddd);
  border-radius: 8px;
  font-size: 0.75rem;
  color: var(--matou-muted-foreground, #6b7280);

  .context-preview-title {
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
}

.success-text {
  font-size: 0.9375rem;
}

.issue-url {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground, #6b7280);
  word-break: break-all;
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
</style>
