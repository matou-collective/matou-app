<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <q-card style="min-width: 400px">
      <q-card-section>
        <div class="text-h6 row items-center q-gutter-sm">
          <q-icon name="favorite" color="pink" />
          <span>Endorse Proposal</span>
        </div>
      </q-card-section>

      <q-card-section>
        <div class="endorse-proposal-box q-pa-md">
          You are about to endorse:
          <div class="text-weight-bold q-mt-sm">{{ proposalTitle }}</div>
        </div>
        <q-input
          v-model="comment"
          label="Comment (optional)"
          type="textarea"
          outlined
          autogrow
          class="q-mt-md"
        />
      </q-card-section>

      <div class="dialog-footer">
        <q-btn no-caps label="Endorse" color="pink" class="dialog-footer-btn" @click="handleEndorse" :loading="loading" />
        <q-btn outline no-caps label="Cancel" color="primary" class="dialog-footer-btn" v-close-popup />
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';

defineProps<{
  modelValue: boolean;
  proposalTitle: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [comment: string];
}>();

const comment = ref('');
const loading = ref(false);

function handleEndorse() {
  emit('confirm', comment.value);
  comment.value = '';
}
</script>

<style scoped lang="scss">
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

.endorse-proposal-box {
  background: var(--matou-teal-light, #f0f9ff);
  border-radius: 8px;
  border: 1px solid var(--border-color, #e5e7eb);
}
</style>
