<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card class="archive-dialog">
      <q-card-section class="row items-center q-pb-none">
        <q-icon :name="icon" :color="iconColor" size="24px" />
        <div class="text-h6 q-ml-sm">{{ title }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section>
        <p>{{ message }}</p>
      </q-card-section>

      <div class="dialog-footer">
        <q-btn
          color="negative"
          no-caps
          unelevated
          :label="confirmLabel"
          class="dialog-footer-btn"
          :loading="loading"
          @click="$emit('confirm')"
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
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
interface Props {
  modelValue: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  icon?: string;
  iconColor?: string;
  loading?: boolean;
}

withDefaults(defineProps<Props>(), {
  confirmLabel: 'Archive',
  icon: 'archive',
  iconColor: 'warning',
  loading: false,
});

defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [];
}>();
</script>

<style scoped lang="scss">
.archive-dialog {
  min-width: 380px;
  max-width: 480px;
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
