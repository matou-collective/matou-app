import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ParticipationInterest } from 'src/lib/participationInterests';

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
  | 'welcome-overlay'
  | 'main';

/**
 * Participation interest options.
 *
 * The vocabulary now lives in the SharedProfile schema (backend enum, issue
 * #301); these are re-exported from src/lib/participationInterests for the
 * built-in metadata and as a fallback. Prefer useParticipationInterests() to
 * source the offered options from the org's schema.
 */
export { PARTICIPATION_INTERESTS } from 'src/lib/participationInterests';
export type { ParticipationInterest } from 'src/lib/participationInterests';

/**
 * Onboarding flow path
 */
export type OnboardingPath = 'register' | 'recover' | 'setup' | 'claim' | 'returning' | 'invite' | null;

/**
 * User profile data
 */
export interface ProfileData {
  name: string;
  bio: string;
  email: string;
  location: string;
  joinReason: string;
  indigenousCommunity: string;
  facebookUrl: string;
  linkedinUrl: string;
  twitterUrl: string;
  instagramUrl: string;
  githubUrl: string;
  gitlabUrl: string;
  avatar: File | null;
  avatarPreview: string | null; // Base64 or object URL for preview
  avatarFileRef: string | null; // Content-addressed fileRef from backend upload
  avatarData: string | null; // Base64-encoded avatar data (for registration message)
  avatarMimeType: string | null; // MIME type of avatar
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
    location: '',
    joinReason: '',
    indigenousCommunity: '',
    facebookUrl: '',
    linkedinUrl: '',
    twitterUrl: '',
    instagramUrl: '',
    githubUrl: '',
    gitlabUrl: '',
    avatar: null,
    avatarPreview: null,
    avatarFileRef: null,
    avatarData: null,
    avatarMimeType: null,
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
      location: '',
      joinReason: '',
      indigenousCommunity: '',
      facebookUrl: '',
      linkedinUrl: '',
      twitterUrl: '',
      instagramUrl: '',
      githubUrl: '',
      gitlabUrl: '',
      avatar: null,
      avatarPreview: null,
      avatarFileRef: null,
      avatarData: null,
      avatarMimeType: null,
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
