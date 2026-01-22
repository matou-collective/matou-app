<template>
  <q-btn
    :class="buttonClasses"
    :disable="disabled"
    :loading="loading"
    no-caps
    unelevated
    v-bind="$attrs"
  >
    <slot />
  </q-btn>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  variant?: 'default' | 'outline' | 'ghost' | 'secondary' | 'destructive';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  disabled?: boolean;
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'default',
  size: 'default',
  disabled: false,
  loading: false,
});

const buttonClasses = computed(() => {
  const classes: string[] = ['m-btn'];

  // Variant classes
  switch (props.variant) {
    case 'default':
      classes.push('m-btn--default');
      break;
    case 'outline':
      classes.push('m-btn--outline');
      break;
    case 'ghost':
      classes.push('m-btn--ghost');
      break;
    case 'secondary':
      classes.push('m-btn--secondary');
      break;
    case 'destructive':
      classes.push('m-btn--destructive');
      break;
  }

  // Size classes
  switch (props.size) {
    case 'default':
      classes.push('m-btn--size-default');
      break;
    case 'sm':
      classes.push('m-btn--size-sm');
      break;
    case 'lg':
      classes.push('m-btn--size-lg');
      break;
    case 'icon':
      classes.push('m-btn--size-icon');
      break;
  }

  return classes;
});
</script>

<style lang="scss" scoped>
.m-btn {
  font-weight: 500;
  transition: all 0.2s ease;
  border-radius: var(--matou-radius-xl);

  :deep(.q-btn__content) {
    gap: 0.5rem;
  }

  // Variants
  &--default {
    background-color: var(--matou-primary) !important;
    color: var(--matou-primary-foreground) !important;

    &:hover:not(.disabled) {
      background-color: rgba(30, 95, 116, 0.9) !important;
    }
  }

  &--outline {
    background-color: transparent !important;
    border: 1px solid var(--matou-border);
    color: var(--matou-foreground) !important;

    &:hover:not(.disabled) {
      background-color: var(--matou-accent) !important;
      color: var(--matou-accent-foreground) !important;
    }
  }

  &--ghost {
    background-color: transparent !important;
    color: var(--matou-foreground) !important;

    &:hover:not(.disabled) {
      background-color: var(--matou-accent) !important;
      color: var(--matou-accent-foreground) !important;
    }
  }

  &--secondary {
    background-color: var(--matou-secondary) !important;
    color: var(--matou-secondary-foreground) !important;

    &:hover:not(.disabled) {
      background-color: rgba(232, 244, 248, 0.8) !important;
    }
  }

  &--destructive {
    background-color: var(--matou-destructive) !important;
    color: var(--matou-destructive-foreground) !important;

    &:hover:not(.disabled) {
      background-color: rgba(200, 70, 58, 0.9) !important;
    }
  }

  // Sizes
  &--size-default {
    height: 2.25rem;
    padding: 0.5rem 1rem;
  }

  &--size-sm {
    height: 2rem;
    padding: 0.25rem 0.75rem;
    font-size: 0.875rem;
  }

  &--size-lg {
    height: 2.75rem;
    padding: 0.75rem 1.5rem;
  }

  &--size-icon {
    height: 2.25rem;
    width: 2.25rem;
    padding: 0;
    min-width: auto;
  }
}
</style>
