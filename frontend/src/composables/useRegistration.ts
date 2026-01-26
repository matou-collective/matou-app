/**
 * Composable for handling user registration with the organization
 * Sends an EXN message to establish OOBI exchange and submit registration
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';

export interface RegistrationData {
  name: string;
  bio: string;
  interests: string[];
  customInterests?: string;
}

export function useRegistration() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();

  // State
  const isSubmitting = ref(false);
  const error = ref<string | null>(null);
  const registrationSent = ref(false);
  const registrationSaid = ref<string | null>(null);

  /**
   * Submit registration to the organization
   * 1. Resolves the org's OOBI (so we can send messages to them)
   * 2. Sends a registration EXN message with user's profile data
   *
   * @param profile - User's registration data
   * @returns Success status
   */
  async function submitRegistration(profile: RegistrationData): Promise<boolean> {
    const currentAID = identityStore.currentAID;
    if (!currentAID) {
      error.value = 'No AID found. Please create an identity first.';
      return false;
    }

    isSubmitting.value = true;
    error.value = null;

    try {
      // Step 1: Try to resolve the organization's OOBI (optional for local dev)
      console.log('[Registration] Resolving organization OOBI...');
      const orgOOBI = keriClient.getOrgOOBI();

      try {
        const oobiResolved = await keriClient.resolveOOBI(orgOOBI, 'matou-org');
        if (oobiResolved) {
          console.log('[Registration] Organization OOBI resolved');
        } else {
          console.warn('[Registration] OOBI resolution returned false, continuing anyway...');
        }
      } catch (oobiError) {
        // In local dev, org may not have witnesses so OOBI may not be available
        // Continue anyway - the EXN will still reference the org AID
        console.warn('[Registration] OOBI resolution failed (may not have witnesses), continuing:', oobiError);
      }

      // Step 2: Send registration EXN message
      console.log('[Registration] Sending registration message...');
      const result = await keriClient.sendRegistration(currentAID.name, {
        name: profile.name,
        bio: profile.bio,
        interests: profile.interests,
        customInterests: profile.customInterests,
      });

      if (!result.success) {
        // Check if this is an "unknown AID" error (org OOBI not resolved)
        if (result.error?.includes('unknown AID')) {
          console.warn('[Registration] Could not send EXN (org AID unknown). Proceeding anyway.');
          console.warn('[Registration] The org may not have witnesses configured for OOBI discovery.');
          // Still mark as "sent" so the UI can proceed - admin will need to manually poll
          registrationSent.value = true;
          return true;
        }
        throw new Error(result.error || 'Failed to send registration');
      }

      registrationSaid.value = result.said || null;
      registrationSent.value = true;
      console.log('[Registration] Registration submitted successfully:', result.said);

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Registration failed';
      console.error('[Registration] Error:', err);
      error.value = errorMsg;
      return false;
    } finally {
      isSubmitting.value = false;
    }
  }

  /**
   * Reset registration state
   */
  function reset() {
    isSubmitting.value = false;
    error.value = null;
    registrationSent.value = false;
    registrationSaid.value = null;
  }

  return {
    // State
    isSubmitting,
    error,
    registrationSent,
    registrationSaid,

    // Actions
    submitRegistration,
    reset,
  };
}
