<template>
  <q-toggle
    v-model="modelValue"
    :class="['m-toggle', { 'm-toggle--disabled': disabled }]"
    :disable="disabled"
    color="accent"
    v-bind="$attrs"
  />
</template>

<script setup lang="ts">
interface Props {
  disabled?: boolean;
}

withDefaults(defineProps<Props>(), {
  disabled: false,
});

const modelValue = defineModel<boolean>({ default: false });
</script>

<style lang="scss" scoped>
.m-toggle {
  :deep(.q-toggle__inner) {
    font-size: 40px;
  }

  :deep(.q-toggle__track) {
    background-color: var(--matou-switch-background);
    opacity: 1;
    transition: background-color 0.2s ease;
  }

  :deep(.q-toggle__thumb) {
    background-color: #ffffff;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  &.q-toggle--active {
    :deep(.q-toggle__track) {
      background-color: var(--matou-accent) !important;
    }
  }

  &--disabled {
    opacity: 0.5;
  }
}
</style>
