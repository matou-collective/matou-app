/**
 * KERI Boot File
 * Attempts to restore identity session on app startup
 */
import { boot } from 'quasar/wrappers';
import { useIdentityStore } from 'stores/identity';

export default boot(async () => {
  const identityStore = useIdentityStore();

  // Attempt to restore session from saved passcode
  const savedPasscode = localStorage.getItem('matou_passcode');
  if (savedPasscode) {
    try {
      console.log('[KERI Boot] Attempting to restore identity session...');
      const success = await identityStore.restore();
      if (success) {
        console.log('[KERI Boot] Session restored successfully');
      } else {
        console.log('[KERI Boot] Failed to restore session, user will need to reconnect');
      }
    } catch (err) {
      console.warn('[KERI Boot] Error restoring session:', err);
      // Clear invalid passcode
      localStorage.removeItem('matou_passcode');
    }
  } else {
    console.log('[KERI Boot] No saved session found');
  }
});
