<template>
  <q-page class="onboarding-page">
    <Transition name="fade-slide" mode="out-in">
      <component
        :is="currentComponent"
        :key="currentScreen"
        v-bind="currentProps"
        @invite-code="startInviteFlow"
        @register="startRegisterFlow"
        @recover="startRecoverFlow"
        @continue="handleContinue"
        @back="handleBack"
        @complete="handleComplete"
        @show-phrase-again="handleShowPhraseAgain"
        @retry="handleRetry"
        @approved="handleApproved"
        @continue-to-dashboard="handleContinueToDashboard"
        @needs-approval="handleNeedsApproval"
        @navigate-to-welcome="handleNavigateToWelcome"
      />
    </Transition>
  </q-page>
</template>

<script setup lang="ts">
import { computed, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useOnboardingStore } from 'stores/onboarding';
import { useIdentityStore } from 'stores/identity';

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
import RecoveryScreen from 'components/onboarding/RecoveryScreen.vue';
import ClaimWelcomeScreen from 'components/onboarding/ClaimWelcomeScreen.vue';
import ClaimProcessingScreen from 'components/onboarding/ClaimProcessingScreen.vue';
import WelcomeOverlayScreen from 'components/onboarding/WelcomeOverlayScreen.vue';

const router = useRouter();
const store = useOnboardingStore();
const identityStore = useIdentityStore();

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
  'recovery': RecoveryScreen,
  'claim-welcome': ClaimWelcomeScreen,
  'claim-processing': ClaimProcessingScreen,
  'welcome-overlay': WelcomeOverlayScreen,
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
      return {
        userName: store.profile.name || 'Member',
        onApproved: handleApproved,
        onContinueToDashboard: handleContinueToDashboard,
      };
    case 'profile-form':
      return store.onboardingPath === 'claim' ? { isClaim: true } : {};
    default:
      return {};
  }
});

// Credential approval handlers
const handleApproved = (credential: any) => {
  console.log('[Onboarding] Credential approved:', credential);
};

const handleContinueToDashboard = async () => {
  // Ensure backend has community space ID before navigating
  await identityStore.fetchUserSpaces();
  await identityStore.verifyCommunityAccess();
  store.navigateTo('main');
};

const handleNeedsApproval = () => {
  // Redirect to pending-approval when returning user has no credential
  store.navigateTo('pending-approval');
};

const handleNavigateToWelcome = () => {
  // Navigate from PendingApprovalScreen to WelcomeOverlayScreen after approval
  store.navigateTo('welcome-overlay');
};

// Navigation handlers
const startInviteFlow = () => {
  store.setPath('claim');
  store.navigateTo('invite-code');
};

const startRegisterFlow = () => {
  store.setPath('register');
  store.navigateTo('matou-info');
};

const startRecoverFlow = () => {
  store.setPath('recover');
  store.navigateTo('recovery');
};

const handleContinue = async (data?: unknown) => {
  const current = currentScreen.value;
  const path = store.onboardingPath;

  // All paths: welcome-overlay → dashboard (ensure community access verified first)
  if (current === 'welcome-overlay') {
    await identityStore.verifyCommunityAccess();
    router.push('/dashboard');
    return;
  }

  // Note: ProfileConfirmationScreen already sets mnemonic and AID in the store before emitting
  // So we don't need to handle the data here - just navigate to next screen

  // Navigate to next screen based on path
  if (path === 'register') {
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
  } else if (path === 'recover') {
    // Recovery flow goes through welcome overlay for membership checks
    if (current === 'recovery') {
      store.navigateTo('welcome-overlay');
    }
  } else if (path === 'setup') {
    // Admin setup flow: profile-confirmation → mnemonic-verification → pending-approval
    const forwardMap: Record<string, string> = {
      'profile-confirmation': 'mnemonic-verification',
      'mnemonic-verification': 'pending-approval',
    };
    const next = forwardMap[current];
    if (next) {
      store.navigateTo(next as typeof store.currentScreen);
    }
  } else if (path === 'claim') {
    // Claim flow: invite-code → claim-welcome → profile-form → claim-processing →
    // profile-confirmation → mnemonic-verification → pending-approval
    // (mnemonic verification submits registration; pending-approval waits for admin approval)
    const forwardMap: Record<string, string> = {
      'invite-code': 'claim-welcome',
      'claim-welcome': 'profile-form',
      'profile-form': 'claim-processing',
      'claim-processing': 'profile-confirmation',
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
  const backMapRegister: Record<string, string | null> = {
    'matou-info': 'splash',
    'profile-form': 'matou-info',
    'profile-confirmation': 'profile-form',
    'mnemonic-verification': 'profile-confirmation',
  };

  const backMapRecover: Record<string, string | null> = {
    'recovery': 'splash',
  };

  const backMapSetup: Record<string, string | null> = {
    'mnemonic-verification': 'profile-confirmation',
    // No back from profile-confirmation in setup flow (can't go back to setup form)
  };

  const backMapClaim: Record<string, string | null> = {
    'invite-code': 'splash',
    'claim-welcome': 'invite-code',
    'profile-form': 'claim-welcome',
    // No back from profile-confirmation (can't undo claim processing)
    'mnemonic-verification': 'profile-confirmation',
  };

  const backMap = path === 'recover'
    ? backMapRecover
    : path === 'setup'
      ? backMapSetup
      : path === 'claim'
        ? backMapClaim
        : backMapRegister;
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

const handleRetry = async () => {
  store.setInitializationError(null);
  store.setAppState('checking');

  try {
    const result = await identityStore.restore();
    if (result.success && result.hasAID) {
      store.navigateTo('pending-approval');
    } else if (result.error) {
      store.setInitializationError(result.error);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    store.setInitializationError(errorMessage);
  } finally {
    store.setAppState('ready');
  }
};

// Watch for navigation to main app
watch(
  () => store.currentScreen,
  (newScreen) => {
    if (newScreen === 'main') {
      router.push('/dashboard');
    } else {
      // Reset scroll position when switching screens
      nextTick(() => {
        // Scroll the page container
        const pageContainer = document.querySelector('.q-page-container');
        if (pageContainer) {
          pageContainer.scrollTop = 0;
        }
        // Scroll the onboarding page
        const onboardingPage = document.querySelector('.onboarding-page');
        if (onboardingPage) {
          onboardingPage.scrollTop = 0;
        }
        // Scroll window as fallback
        window.scrollTo(0, 0);
      });
    }
  },
);
</script>

<style lang="scss" scoped>
.onboarding-page {
  min-height: calc(100vh - var(--titlebar-height)) !important;
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
