import { computed } from 'vue';
import { useOnboardingStore, type OnboardingScreen } from 'stores/onboarding';

/**
 * Composable for onboarding navigation and flow logic
 */
export function useOnboarding() {
  const store = useOnboardingStore();

  /**
   * Current screen being displayed
   */
  const currentScreen = computed(() => store.currentScreen);

  /**
   * Whether we're on the invite code path
   */
  const isInvitePath = computed(() => store.onboardingPath === 'invite');

  /**
   * Whether we're on the registration path
   */
  const isRegisterPath = computed(() => store.onboardingPath === 'register');

  /**
   * Navigate to a specific screen
   */
  const goTo = (screen: OnboardingScreen) => {
    store.navigateTo(screen);
  };

  /**
   * Start the invite code flow
   */
  const startInviteFlow = () => {
    store.setPath('invite');
    store.navigateTo('invite-code');
  };

  /**
   * Start the registration flow
   */
  const startRegisterFlow = () => {
    store.setPath('register');
    store.navigateTo('matou-info');
  };

  /**
   * Go back to the splash screen
   */
  const goToSplash = () => {
    store.reset();
  };

  /**
   * Navigate back within the current flow
   */
  const goBack = () => {
    const currentScreenValue = store.currentScreen;
    const path = store.onboardingPath;

    // Define back navigation based on current screen
    const backMap: Partial<Record<OnboardingScreen, OnboardingScreen>> = {
      'invite-code': 'splash',
      'invitation-welcome': 'invite-code',
      'profile-form': path === 'invite' ? 'invitation-welcome' : 'matou-info',
      'profile-confirmation': 'profile-form',
      'mnemonic-verification': 'profile-confirmation',
      'matou-info': 'splash',
    };

    const previousScreen = backMap[currentScreenValue];
    if (previousScreen === 'splash') {
      goToSplash();
    } else if (previousScreen) {
      goTo(previousScreen);
    }
  };

  /**
   * Continue to the next screen in the flow
   */
  const continueFlow = () => {
    const currentScreenValue = store.currentScreen;
    const path = store.onboardingPath;

    // Define forward navigation based on current screen and path
    if (path === 'invite') {
      const forwardMap: Partial<Record<OnboardingScreen, OnboardingScreen>> = {
        'invite-code': 'invitation-welcome',
        'invitation-welcome': 'profile-form',
        'profile-form': 'profile-confirmation',
        'profile-confirmation': 'mnemonic-verification',
        'mnemonic-verification': 'credential-issuance',
        'credential-issuance': 'main',
      };
      const nextScreen = forwardMap[currentScreenValue];
      if (nextScreen) {
        goTo(nextScreen);
      }
    } else if (path === 'register') {
      const forwardMap: Partial<Record<OnboardingScreen, OnboardingScreen>> = {
        'matou-info': 'profile-form',
        'profile-form': 'profile-confirmation',
        'profile-confirmation': 'mnemonic-verification',
        'mnemonic-verification': 'pending-approval',
      };
      const nextScreen = forwardMap[currentScreenValue];
      if (nextScreen) {
        goTo(nextScreen);
      }
    }
  };

  /**
   * Complete onboarding and go to main app
   */
  const completeOnboarding = () => {
    store.navigateTo('main');
  };

  /**
   * Set the invite code
   */
  const setInviteCode = (code: string) => {
    store.setInviteCode(code);
  };

  /**
   * Set the inviter name
   */
  const setInviterName = (name: string) => {
    store.setInviterName(name);
  };

  /**
   * Update profile data
   */
  const updateProfile = (data: Partial<{ name: string; bio: string; email: string }>) => {
    store.updateProfile(data);
  };

  /**
   * Set the user's AID
   */
  const setUserAID = (aid: string) => {
    store.setUserAID(aid);
  };

  return {
    // State
    currentScreen,
    isInvitePath,
    isRegisterPath,
    inviteCode: computed(() => store.inviteCode),
    inviterName: computed(() => store.inviterName),
    profile: computed(() => store.profile),
    userAID: computed(() => store.userAID),

    // Navigation
    goTo,
    goBack,
    continueFlow,
    goToSplash,
    startInviteFlow,
    startRegisterFlow,
    completeOnboarding,

    // Data setters
    setInviteCode,
    setInviterName,
    updateProfile,
    setUserAID,
  };
}
