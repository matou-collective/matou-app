/**
 * KERI Boot File
 * Initiates identity session restoration on app startup
 * Note: Restore runs asynchronously so Vue can mount and show loading state
 */
import { boot } from 'quasar/wrappers';
import { useIdentityStore } from 'stores/identity';
import { useOnboardingStore } from 'stores/onboarding';

async function restoreIdentity(
  identityStore: ReturnType<typeof useIdentityStore>,
  onboardingStore: ReturnType<typeof useOnboardingStore>
) {
  try {
    console.log('[KERI Boot] Attempting to restore identity session...');
    const result = await identityStore.restore();

    if (result.success && result.hasAID) {
      console.log('[KERI Boot] Session restored with AID, navigating to pending-approval');
      onboardingStore.navigateTo('pending-approval');
    } else if (result.success) {
      console.log('[KERI Boot] Session restored but no AID found');
    } else if (result.error) {
      console.warn('[KERI Boot] Failed to restore session:', result.error);
      onboardingStore.setInitializationError(result.error);
      localStorage.removeItem('matou_passcode');
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error during restore';
    console.warn('[KERI Boot] Error restoring session:', err);
    onboardingStore.setInitializationError(errorMessage);
    localStorage.removeItem('matou_passcode');
  } finally {
    onboardingStore.setAppState('ready');
    identityStore.setInitialized();
  }
}

export default boot(({ app }) => {
  const identityStore = useIdentityStore();
  const onboardingStore = useOnboardingStore();

  const savedPasscode = localStorage.getItem('matou_passcode');

  if (!savedPasscode) {
    console.log('[KERI Boot] No saved session found');
    onboardingStore.setAppState('ready');
    identityStore.setInitialized();
    return;
  }

  // Set checking state and start restore WITHOUT awaiting
  // This allows Vue to mount and show loading state while restore runs
  onboardingStore.setAppState('checking');

  // Start restore asynchronously - Vue will mount and observe state changes
  restoreIdentity(identityStore, onboardingStore);
});
