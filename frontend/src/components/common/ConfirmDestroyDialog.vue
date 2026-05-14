<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card class="destroy-dialog">
      <q-card-section class="row items-center q-pb-none">
        <q-icon name="warning" color="negative" size="28px" />
        <div class="text-h6 q-ml-sm">{{ title }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup @click="reset" />
      </q-card-section>

      <q-card-section>
        <p class="q-mb-sm">
          You are about to permanently archive
          <strong>{{ entityLabel }}</strong>. This will also archive:
        </p>
        <ul class="cascade-list">
          <li v-for="(item, i) in cascadeSummary" :key="i">{{ item }}</li>
        </ul>
        <p class="text-warning q-mt-md">
          This cannot be undone from the UI. To confirm, type
          <strong class="confirm-word">{{ confirmWord }}</strong> below.
        </p>

        <q-input
          v-model="typed"
          :label="`Type ${confirmWord} to confirm`"
          outlined
          dense
          autofocus
          @keyup.enter="onConfirm"
        />
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat label="Cancel" v-close-popup @click="reset" />
        <q-btn
          color="negative"
          unelevated
          :label="title"
          :disable="!matches"
          :loading="loading"
          @click="onConfirm"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';

interface Props {
  modelValue: boolean;
  title: string;
  entityLabel: string;
  cascadeSummary: string[];
  confirmWord?: string;
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  confirmWord: 'DESTROY',
  loading: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [];
}>();

const typed = ref('');
const matches = computed(() => typed.value === props.confirmWord);

function reset() {
  typed.value = '';
}

function onConfirm() {
  if (!matches.value) return;
  emit('confirm');
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) reset();
  },
);
</script>

<style scoped lang="scss">
.destroy-dialog {
  min-width: 480px;
  max-width: 560px;
}
.cascade-list {
  margin: 8px 0 0 0;
  padding-left: 20px;
  color: var(--matou-foreground);
}
.cascade-list li {
  padding: 2px 0;
  font-size: 0.9rem;
}
.confirm-word {
  letter-spacing: 1px;
  color: var(--matou-destructive);
  font-family: monospace;
}
.text-warning {
  color: var(--matou-destructive);
  font-size: 0.9rem;
}
</style>
