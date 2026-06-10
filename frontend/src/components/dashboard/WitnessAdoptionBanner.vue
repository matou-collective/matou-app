<template>
  <div data-test="witness-adoption-banner" class="witness-adoption-banner">
    <div class="banner-content">
      <span class="banner-icon" aria-hidden="true">⚠</span>
      <div class="banner-text">
        <strong>Org needs witness migration</strong>
        <p>
          This org was created before witness-backed upgrades were supported.
          Adopt witnesses to enable promoting members to steward.
        </p>
        <p v-if="errorMessage" class="banner-error">{{ errorMessage }}</p>
      </div>
      <button
        type="button"
        class="banner-button"
        :disabled="loading"
        @click="$emit('adopt')"
      >
        <span v-if="loading">Adopting…</span>
        <span v-else>Adopt witnesses</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  loading: boolean;
  errorMessage?: string;
}>();
defineEmits<{
  (e: 'adopt'): void;
}>();
</script>

<style scoped>
.witness-adoption-banner {
  background: #fff5e6;
  border: 1px solid #f4b860;
  border-radius: 8px;
  padding: 12px 16px;
  margin: 12px 0;
  color: #5a3a00;
}
.dark .witness-adoption-banner {
  background: #3a2a10;
  border-color: #f4b860;
  color: #ffd9a5;
}
.banner-content {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.banner-icon {
  font-size: 1.4em;
  line-height: 1;
}
.banner-text {
  flex: 1;
}
.banner-text strong {
  display: block;
  margin-bottom: 4px;
}
.banner-text p {
  margin: 0;
  font-size: 0.92em;
  line-height: 1.4;
}
.banner-error {
  color: #b00020;
  margin-top: 6px !important;
}
.banner-button {
  background: #5a3a00;
  color: #fff;
  border: none;
  padding: 8px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9em;
  align-self: center;
  white-space: nowrap;
}
.banner-button:disabled {
  opacity: 0.6;
  cursor: progress;
}
.dark .banner-button {
  background: #f4b860;
  color: #2a1a00;
}
</style>
