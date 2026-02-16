<template>
  <div class="m-input-wrapper">
    <q-input
      v-model="modelValue"
      :class="['m-input', { 'm-input--error': hasError }]"
      :type="type"
      :placeholder="placeholder"
      :disable="disabled"
      outlined
      dense
      v-bind="$attrs"
    >
      <template v-if="$slots.prepend" #prepend>
        <slot name="prepend" />
      </template>
      <template v-if="$slots.append" #append>
        <slot name="append" />
      </template>
    </q-input>
    <div v-if="hasError && errorMessage" class="m-input__error">
      <slot name="error">
        {{ errorMessage }}
      </slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  type?: 'text' | 'email' | 'password' | 'number' | 'tel' | 'url';
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  errorMessage?: string;
}

const props = withDefaults(defineProps<Props>(), {
  type: 'text',
  placeholder: '',
  disabled: false,
  error: false,
  errorMessage: '',
});

const modelValue = defineModel<string>({ default: '' });

const hasError = computed(() => props.error || !!props.errorMessage);
</script>

<style lang="scss" scoped>
.m-input-wrapper {
  width: 100%;
}

.m-input {
  :deep(.q-field__control) {
    background-color: var(--matou-input-background);
    border-radius: var(--matou-radius);
    transition: all 0.2s ease;

    &::before {
      border-color: var(--matou-border);
    }

    &:hover::before {
      border-color: var(--matou-primary);
    }
  }

  :deep(.q-field--focused .q-field__control) {
    &::before {
      border-color: var(--matou-ring);
    }

    &::after {
      border-color: var(--matou-ring);
    }
  }

  :deep(.q-field__native) {
    color: var(--matou-foreground);

    &::placeholder {
      color: var(--matou-muted-foreground);
    }
  }

  &--error {
    :deep(.q-field__control) {
      &::before {
        border-color: var(--matou-destructive) !important;
      }
    }
  }
}

.m-input__error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
  color: var(--matou-destructive);
  font-size: 0.875rem;
}
</style>
