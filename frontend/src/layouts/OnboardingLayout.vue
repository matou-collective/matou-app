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
  min-height: 100vh;
}

:deep(.q-page-container) {
  min-height: 100vh;
}
</style>
