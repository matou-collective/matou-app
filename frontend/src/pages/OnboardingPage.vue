<template>
  <q-page class="onboarding-page">
    <Transition name="fade-slide" mode="out-in">
      <component
        :is="currentComponent"
        :key="currentScreen"
        v-bind="currentProps"
        @invite-code="startInviteFlow"
        @register="startRegisterFlow"
        @continue="handleContinue"
        @back="handleBack"
        @complete="handleComplete"
      />
    </Transition>
  </q-page>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useOnboardingStore } from 'stores/onboarding';

// Import onboarding screens
import SplashScreen from 'components/onboarding/SplashScreen.vue';
import InviteCodeScreen from 'components/onboarding/InviteCodeScreen.vue';
import InvitationWelcomeScreen from 'components/onboarding/InvitationWelcomeScreen.vue';
import MatouInformationScreen from 'components/onboarding/MatouInformationScreen.vue';
import RegistrationScreen from 'components/onboarding/RegistrationScreen.vue';
import CredentialIssuanceScreen from 'components/onboarding/CredentialIssuanceScreen.vue';
import PendingApprovalScreen from 'components/onboarding/PendingApprovalScreen.vue';

const router = useRouter();
const store = useOnboardingStore();

const currentScreen = computed(() => store.currentScreen);

// Map screens to components
const screenComponents = {
  splash: SplashScreen,
  'invite-code': InviteCodeScreen,
  'invitation-welcome': InvitationWelcomeScreen,
  'matou-info': MatouInformationScreen,
  'create-profile-invite': RegistrationScreen,
  'create-profile-register': RegistrationScreen,
  'credential-issuance': CredentialIssuanceScreen,
  'pending-approval': PendingApprovalScreen,
};

const currentComponent = computed(() => {
  return screenComponents[currentScreen.value as keyof typeof screenComponents] || SplashScreen;
});

// Props for each screen
const currentProps = computed(() => {
  switch (currentScreen.value) {
    case 'invitation-welcome':
      return { inviterName: store.inviterName };
    case 'credential-issuance':
      return { userAID: store.userAID };
    case 'pending-approval':
      return { userName: store.profile.name || 'Member' };
    default:
      return {};
  }
});

// Navigation handlers
const startInviteFlow = () => {
  store.setPath('invite');
  store.navigateTo('invite-code');
};

const startRegisterFlow = () => {
  store.setPath('register');
  store.navigateTo('matou-info');
};

const handleContinue = (data?: unknown) => {
  const current = currentScreen.value;
  const path = store.onboardingPath;

  // Handle data passed from screens
  if (current === 'invite-code' && typeof data === 'string') {
    store.setInviterName(data);
  }

  if (current === 'create-profile-invite' || current === 'create-profile-register') {
    const profileData = data as { name: string; email: string; aid: string } | undefined;
    if (profileData) {
      store.updateProfile({ name: profileData.name, email: profileData.email });
      store.setUserAID(profileData.aid);
    }
  }

  // Navigate to next screen
  if (path === 'invite') {
    const forwardMap: Record<string, string> = {
      'invite-code': 'invitation-welcome',
      'invitation-welcome': 'create-profile-invite',
      'create-profile-invite': 'credential-issuance',
    };
    const next = forwardMap[current];
    if (next) {
      store.navigateTo(next as typeof store.currentScreen);
    }
  } else if (path === 'register') {
    const forwardMap: Record<string, string> = {
      'matou-info': 'create-profile-register',
      'create-profile-register': 'pending-approval',
    };
    const next = forwardMap[current];
    if (next) {
      store.navigateTo(next as typeof store.currentScreen);
    }
  }
};

const handleBack = () => {
  const current = currentScreen.value;

  const backMap: Record<string, string | null> = {
    'invite-code': 'splash',
    'invitation-welcome': 'invite-code',
    'create-profile-invite': 'invitation-welcome',
    'matou-info': 'splash',
    'create-profile-register': 'matou-info',
  };

  const prev = backMap[current];

  if (prev === 'splash') {
    store.reset();
  } else if (prev) {
    store.navigateTo(prev as typeof store.currentScreen);
  }
};

const handleComplete = () => {
  store.navigateTo('main');
};

// Watch for navigation to main app
watch(
  () => store.currentScreen,
  (newScreen) => {
    if (newScreen === 'main') {
      router.push('/dashboard');
    }
  },
);
</script>

<style lang="scss" scoped>
.onboarding-page {
  min-height: 100vh;
}

// Transition animations
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.3s ease;
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateX(20px);
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateX(-20px);
}
</style>
