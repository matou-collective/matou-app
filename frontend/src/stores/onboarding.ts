import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

/**
 * All possible onboarding screens
 */
export type OnboardingScreen =
  | 'splash'
  | 'invite-code'
  | 'invitation-welcome'
  | 'profile-form'
  | 'profile-confirmation'
  | 'mnemonic-verification'
  | 'credential-issuance'
  | 'matou-info'
  | 'pending-approval'
  | 'recovery'
  | 'claim-welcome'
  | 'claim-processing'
  | 'main';

/**
 * Participation interest options
 */
export const PARTICIPATION_INTERESTS = [
  {
    value: 'research_knowledge',
    label: 'Research and Knowledge',
    description: 'Support inquiry, documentation, and knowledge sharing.',
  },
  {
    value: 'coordination_operations',
    label: 'Coordination and Operations',
    description: 'Organize efforts, track tasks, and improve processes.',
  },
  {
    value: 'art_design',
    label: 'Art and Designs',
    description: 'Create graphics, UI/UX, and brand assets.',
  },
  {
    value: 'discussion_community_input',
    label: 'Discussions and Community Input',
    description: 'Participate in conversations and share feedback.',
  },
  {
    value: 'follow_learn',
    label: 'Follow and Learn',
    description: 'Stay informed and learn at your own pace.',
  },
  {
    value: 'coding_technical_dev',
    label: 'Coding and Technical Dev',
    description: 'Build and maintain software and infrastructure.',
  },
  {
    value: 'cultural_oversight',
    label: 'Cultural Oversight',
    description: 'Ensure cultural alignment and respectful practices.',
  },
] as const;

export type ParticipationInterest = typeof PARTICIPATION_INTERESTS[number]['value'];

/**
 * Onboarding flow path
 */
export type OnboardingPath = 'register' | 'recover' | 'setup' | 'claim' | null;

/**
 * User profile data
 */
export interface ProfileData {
  name: string;
  bio: string;
  email: string;
  avatar: File | null;
  avatarPreview: string | null; // Base64 or object URL for preview
  participationInterests: ParticipationInterest[];
  customInterests: string;
  hasAgreedToTerms: boolean;
}

/**
 * Mnemonic verification state
 */
export interface MnemonicState {
  words: string[];
  verificationIndices: number[]; // Which 3 words to verify
  attempts: number;
  verified: boolean;
}

/**
 * App initialization states
 */
export type AppState = 'initializing' | 'checking' | 'ready';

/**
 * Onboarding store - manages the onboarding flow state
 */
export const useOnboardingStore = defineStore('onboarding', () => {
  // State
  const currentScreen = ref<OnboardingScreen>('splash');
  const onboardingPath = ref<OnboardingPath>(null);
  const inviteCode = ref('');
  const inviterName = ref('');
  const appState = ref<AppState>('initializing');
  const initializationError = ref<string | null>(null);
  const profile = ref<ProfileData>({
    name: '',
    bio: '',
    email: '',
    avatar: null,
    avatarPreview: null,
    participationInterests: [],
    customInterests: '',
    hasAgreedToTerms: false,
  });
  const userAID = ref<string | null>(null);
  const claimPasscode = ref<string | null>(null);
  const claimAidInfo = ref<{ name: string; prefix: string } | null>(null);
  const mnemonic = ref<MnemonicState>({
    words: [],
    verificationIndices: [],
    attempts: 0,
    verified: false,
  });

  // Computed
  const isOnboarding = computed(() => currentScreen.value !== 'main');
  const isLoading = computed(() => appState.value !== 'ready');

  // Actions
  function setAppState(state: AppState) {
    appState.value = state;
  }

  function setInitializationError(error: string | null) {
    initializationError.value = error;
  }

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

  function setClaimPasscode(passcode: string) {
    claimPasscode.value = passcode;
  }

  function setClaimAidInfo(info: { name: string; prefix: string } | null) {
    claimAidInfo.value = info;
  }

  function setMnemonic(words: string[]) {
    // Generate 3 random indices for verification
    const indices = generateRandomIndices(words.length, 3);
    mnemonic.value = {
      words,
      verificationIndices: indices,
      attempts: 0,
      verified: false,
    };
  }

  function recordVerificationAttempt(success: boolean) {
    if (success) {
      mnemonic.value.verified = true;
    } else {
      mnemonic.value.attempts += 1;
    }
  }

  function resetMnemonicVerification() {
    // Regenerate verification indices and reset attempts
    if (mnemonic.value.words.length > 0) {
      mnemonic.value.verificationIndices = generateRandomIndices(mnemonic.value.words.length, 3);
      mnemonic.value.attempts = 0;
      mnemonic.value.verified = false;
    }
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
      avatarPreview: null,
      participationInterests: [],
      customInterests: '',
      hasAgreedToTerms: false,
    };
    userAID.value = null;
    claimPasscode.value = null;
    claimAidInfo.value = null;
    mnemonic.value = {
      words: [],
      verificationIndices: [],
      attempts: 0,
      verified: false,
    };
    initializationError.value = null;
  }

  // Helper: Generate random unique indices
  function generateRandomIndices(length: number, count: number): number[] {
    const indices: number[] = [];
    while (indices.length < count && indices.length < length) {
      const rand = Math.floor(Math.random() * length);
      if (!indices.includes(rand)) {
        indices.push(rand);
      }
    }
    return indices.sort((a, b) => a - b);
  }

  return {
    // State
    currentScreen,
    onboardingPath,
    inviteCode,
    inviterName,
    profile,
    userAID,
    claimPasscode,
    claimAidInfo,
    mnemonic,
    appState,
    initializationError,

    // Computed
    isOnboarding,
    isLoading,

    // Actions
    setAppState,
    setInitializationError,
    setPath,
    navigateTo,
    setInviteCode,
    setInviterName,
    updateProfile,
    setUserAID,
    setClaimPasscode,
    setClaimAidInfo,
    setMnemonic,
    recordVerificationAttempt,
    resetMnemonicVerification,
    reset,
  };
});
