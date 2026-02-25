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
  min-height: calc(100vh - 36px);
}

:deep(.q-page-container) {
  min-height: calc(100vh - 36px);
}
</style>
