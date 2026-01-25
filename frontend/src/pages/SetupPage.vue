<template>
  <q-page class="setup-page">
    <OrgSetupScreen @setup-complete="handleSetupComplete" />
  </q-page>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAppStore } from 'stores/app';
import OrgSetupScreen from 'components/setup/OrgSetupScreen.vue';

const router = useRouter();
const appStore = useAppStore();

async function handleSetupComplete() {
  // Reload org config to update the store
  await appStore.loadOrgConfig();

  // Navigate to the main onboarding flow
  router.push('/');
}
</script>

<style lang="scss" scoped>
.setup-page {
  min-height: 100vh;
}
</style>
