/**
 * KERI Boot File
 * Checks org config and initiates identity session restoration on app startup
 */
import { boot } from 'quasar/wrappers';
import { useIdentityStore } from 'stores/identity';
import { useOnboardingStore } from 'stores/onboarding';
import { useAppStore } from 'stores/app';
import { useKERIClient } from 'src/lib/keri/client';
import { getBackendIdentity, setBackendIdentity } from 'src/lib/api/client';
import { secureStorage } from 'src/lib/secureStorage';

/**
 * Ensure the backend has identity configured. If the backend was restarted,
 * re-send the identity (AID + mnemonic) so it can derive peer keys and restart the SDK.
 */
async function ensureBackendIdentity(
  identityStore: ReturnType<typeof useIdentityStore>,
) {
  const aid = identityStore.currentAID;
  if (!aid) return;

  const backendIdentity = await getBackendIdentity();
  if (backendIdentity.configured && backendIdentity.aid === aid.prefix) {
    console.log('[KERI Boot] Backend identity already configured');
    return;
  }

  // Backend identity is missing or stale — re-set it
  const savedMnemonic = await secureStorage.getItem('matou_mnemonic');
  if (!savedMnemonic) {
    console.warn('[KERI Boot] No mnemonic in storage, cannot re-set backend identity');
    return;
  }

  const appStore = useAppStore();
  console.log('[KERI Boot] Re-setting backend identity...');
  const result = await setBackendIdentity({
    aid: aid.prefix,
    mnemonic: savedMnemonic,
    orgAid: appStore.orgAid ?? undefined,
    communitySpaceId: identityStore.communitySpaceId ?? undefined,
  });

  if (result.success) {
    console.log('[KERI Boot] Backend identity re-set, peer:', result.peerId);
  } else {
    console.warn('[KERI Boot] Backend identity re-set failed:', result.error);
  }
}

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

      // Re-sync backend identity if backend was restarted (non-blocking)
      ensureBackendIdentity(identityStore).catch((err) => {
        console.warn('[KERI Boot] Backend identity sync deferred:', err);
      });

      // Fetch user spaces and verify access in background (don't block navigation)
      identityStore.fetchUserSpaces().then(() => {
        identityStore.verifyCommunityAccess();
      });
    } else if (result.success) {
      console.log('[KERI Boot] Session restored but no AID found');
    } else if (result.error) {
      console.warn('[KERI Boot] Failed to restore session:', result.error);
      onboardingStore.setInitializationError(result.error);
      await secureStorage.removeItem('matou_passcode');
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error during restore';
    console.warn('[KERI Boot] Error restoring session:', err);
    onboardingStore.setInitializationError(errorMessage);
    await secureStorage.removeItem('matou_passcode');
  } finally {
    onboardingStore.setAppState('ready');
    identityStore.setInitialized();
  }
}

export default boot(async ({ router }) => {
  const identityStore = useIdentityStore();
  const onboardingStore = useOnboardingStore();
  const appStore = useAppStore();
  const keriClient = useKERIClient();

  // Step 1: Fetch org config from server (with localStorage fallback)
  console.log('[KERI Boot] Fetching organization config...');
  await appStore.loadOrgConfig();

  // Add navigation guard to handle setup redirect and dashboard access
  router.beforeEach(async (to, _from, next) => {
    // If org needs setup and we're not already on setup page, redirect
    if (appStore.needsSetup && to.path !== '/setup') {
      console.log('[KERI Boot] Redirecting to setup (org not configured)');
      next('/setup');
      return;
    }

    // If org is configured and we're on setup page, redirect to home
    if (appStore.isConfigured && to.path === '/setup') {
      console.log('[KERI Boot] Org already configured, redirecting to home');
      next('/');
      return;
    }

    // Block dashboard access without verified community space access
    if (to.path === '/dashboard') {
      if (!identityStore.hasIdentity) {
        next('/');
        return;
      }

      if (identityStore.communityAccessVerified) {
        next();
        return;
      }

      // Try to verify
      if (!identityStore.spacesLoaded) {
        await identityStore.fetchUserSpaces();
      }

      if (!identityStore.communitySpaceId) {
        next('/');
        return;
      }

      const hasAccess = await identityStore.verifyCommunityAccess();
      if (!hasAccess) {
        next('/');
        return;
      }
    }

    next();
  });

  // Handle different config states
  if (appStore.hasConfigError) {
    // Server unreachable AND no cached config - show error
    console.error('[KERI Boot] Cannot reach config server and no cached config');
    onboardingStore.setInitializationError(appStore.configError || 'Cannot connect to config server');
    onboardingStore.setAppState('ready');
    identityStore.setInitialized();
    return;
  }

  if (appStore.needsSetup) {
    // Server reachable but not configured - navigation guard will redirect
    console.log('[KERI Boot] Org not configured, navigation guard will redirect to setup');
    onboardingStore.setAppState('ready');
    identityStore.setInitialized();
    return;
  }

  // Config is available (from server or cache)
  console.log('[KERI Boot] Org config loaded:', appStore.orgName);

  // Update KERI client with org AID from config
  if (appStore.orgAid) {
    keriClient.setOrgAID(appStore.orgAid);
  }

  // Step 2: Check for saved user session
  const savedPasscode = await secureStorage.getItem('matou_passcode');

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
