<template>
  <q-layout view="hHh lpR fFf">
    <!-- App-header language picker: onboarding/setup screens have no sidebar,
         so the picker sits in a fixed top-right corner where a non-English
         member meets it on first run (#783). -->
    <div class="onboarding-lang-picker">
      <LanguagePicker />
    </div>
    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
// Simple layout wrapper for onboarding and main pages
// Full screen layout without header/footer
import LanguagePicker from 'src/components/base/LanguagePicker.vue';
</script>

<style lang="scss" scoped>
.q-layout {
  // Override Quasar's inline min-height: ${screen.height}px which doesn't
  // account for the Electron titlebar spacer
  min-height: calc(100vh - var(--titlebar-height)) !important;
}

:deep(.q-page-container) {
  min-height: calc(100vh - var(--titlebar-height));
}

.onboarding-lang-picker {
  position: fixed;
  top: calc(var(--titlebar-height) + 0.75rem);
  right: 1rem;
  z-index: 50;
  // Picker chrome is light-on-brand here (onboarding screens use a brand
  // gradient / dark art), so give the trigger a legible contrast.
  color: #ffffff;
}
</style>
