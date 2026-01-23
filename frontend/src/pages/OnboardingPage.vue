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
        @show-phrase-again="handleShowPhraseAgain"
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
import ProfileFormScreen from 'components/onboarding/ProfileFormScreen.vue';
import ProfileConfirmationScreen from 'components/onboarding/ProfileConfirmationScreen.vue';
import MnemonicVerificationScreen from 'components/onboarding/MnemonicVerificationScreen.vue';
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
  'profile-form': ProfileFormScreen,
  'profile-confirmation': ProfileConfirmationScreen,
  'mnemonic-verification': MnemonicVerificationScreen,
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
    case 'mnemonic-verification':
      return {
        mnemonic: store.mnemonic.words,
        verificationIndices: store.mnemonic.verificationIndices,
        attempts: store.mnemonic.attempts,
      };
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

  // Note: ProfileConfirmationScreen already sets mnemonic and AID in the store before emitting
  // So we don't need to handle the data here - just navigate to next screen

  // Navigate to next screen based on path
  // Flow: profile-form → profile-confirmation (includes mnemonic) → mnemonic-verification → credential-issuance/pending-approval
  if (path === 'invite') {
    const forwardMap: Record<string, string> = {
      'invite-code': 'invitation-welcome',
      'invitation-welcome': 'profile-form',
      'profile-form': 'profile-confirmation',
      'profile-confirmation': 'mnemonic-verification',
      'mnemonic-verification': 'credential-issuance',
    };
    const next = forwardMap[current];
    if (next) {
      store.navigateTo(next as typeof store.currentScreen);
    }
  } else if (path === 'register') {
    const forwardMap: Record<string, string> = {
      'matou-info': 'profile-form',
      'profile-form': 'profile-confirmation',
      'profile-confirmation': 'mnemonic-verification',
      'mnemonic-verification': 'pending-approval',
    };
    const next = forwardMap[current];
    if (next) {
      store.navigateTo(next as typeof store.currentScreen);
    }
  }
};

const handleBack = () => {
  const current = currentScreen.value;
  const path = store.onboardingPath;

  // Define back navigation based on current path
  const backMapInvite: Record<string, string | null> = {
    'invite-code': 'splash',
    'invitation-welcome': 'invite-code',
    'profile-form': 'invitation-welcome',
    'profile-confirmation': 'profile-form',
    'mnemonic-verification': 'profile-confirmation',
  };

  const backMapRegister: Record<string, string | null> = {
    'matou-info': 'splash',
    'profile-form': 'matou-info',
    'profile-confirmation': 'profile-form',
    'mnemonic-verification': 'profile-confirmation',
  };

  const backMap = path === 'invite' ? backMapInvite : backMapRegister;
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

const handleShowPhraseAgain = () => {
  // Reset verification state and go back to profile confirmation (which shows mnemonic)
  store.resetMnemonicVerification();
  store.navigateTo('profile-confirmation');
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
