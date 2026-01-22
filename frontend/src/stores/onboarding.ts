import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

/**
 * All possible onboarding screens
 */
export type OnboardingScreen =
  | 'splash'
  | 'invite-code'
  | 'invitation-welcome'
  | 'create-profile-invite'
  | 'credential-issuance'
  | 'matou-info'
  | 'create-profile-register'
  | 'pending-approval'
  | 'main';

/**
 * Onboarding flow path
 */
export type OnboardingPath = 'invite' | 'register' | null;

/**
 * User profile data
 */
export interface ProfileData {
  name: string;
  bio: string;
  email: string;
  avatar: File | null;
}

/**
 * Onboarding store - manages the onboarding flow state
 */
export const useOnboardingStore = defineStore('onboarding', () => {
  // State
  const currentScreen = ref<OnboardingScreen>('splash');
  const onboardingPath = ref<OnboardingPath>(null);
  const inviteCode = ref('');
  const inviterName = ref('');
  const profile = ref<ProfileData>({
    name: '',
    bio: '',
    email: '',
    avatar: null,
  });
  const userAID = ref<string | null>(null);

  // Computed
  const isOnboarding = computed(() => currentScreen.value !== 'main');

  // Actions
  function setPath(path: OnboardingPath) {
    onboardingPath.value = path;
  }

  function navigateTo(screen: OnboardingScreen) {
    currentScreen.value = screen;
  }

  function setInviteCode(code: string) {
    inviteCode.value = code;
  }

  function setInviterName(name: string) {
    inviterName.value = name;
  }

  function updateProfile(data: Partial<ProfileData>) {
    profile.value = { ...profile.value, ...data };
  }

  function setUserAID(aid: string) {
    userAID.value = aid;
  }

  function reset() {
    currentScreen.value = 'splash';
    onboardingPath.value = null;
    inviteCode.value = '';
    inviterName.value = '';
    profile.value = {
      name: '',
      bio: '',
      email: '',
      avatar: null,
    };
    userAID.value = null;
  }

  return {
    // State
    currentScreen,
    onboardingPath,
    inviteCode,
    inviterName,
    profile,
    userAID,

    // Computed
    isOnboarding,

    // Actions
    setPath,
    navigateTo,
    setInviteCode,
    setInviterName,
    updateProfile,
    setUserAID,
    reset,
  };
});
