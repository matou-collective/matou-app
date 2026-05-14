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

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat label="Cancel" v-close-popup />
        <q-btn
          color="negative"
          unelevated
          :label="confirmLabel"
          :loading="loading"
          @click="$emit('confirm')"
        />
      </q-card-actions>
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
</style>
