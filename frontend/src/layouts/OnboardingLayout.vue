<template>
  <q-layout view="hHh lpR fFf">
    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
// Simple layout wrapper for onboarding and main pages
// Full screen layout without header/footer
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
</style>
