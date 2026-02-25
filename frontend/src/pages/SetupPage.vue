<template>
  <q-page class="setup-page">
    <OrgSetupScreen @setup-complete="handleSetupComplete" />
  </q-page>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAppStore } from 'stores/app';
import { useOnboardingStore } from 'stores/onboarding';
import OrgSetupScreen from 'components/setup/OrgSetupScreen.vue';

const router = useRouter();
const appStore = useAppStore();
const onboardingStore = useOnboardingStore();

async function handleSetupComplete() {
  // Reload org config to update the store
  await appStore.loadOrgConfig();

  // Set path so OnboardingPage knows the navigation flow
  onboardingStore.setPath('setup');
  onboardingStore.navigateTo('profile-confirmation');

  // Navigate to onboarding page which will show profile-confirmation
  router.push('/');
}
</script>

<style lang="scss" scoped>
.setup-page {
  min-height: calc(100vh - 36px);
}
</style>
