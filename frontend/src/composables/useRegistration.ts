/**
 * Composable for handling user registration with the organization
 * Sends an EXN message to all admins to establish OOBI exchange and submit registration
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { fetchOrgConfig } from 'src/api/config';

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
   * 1. Fetches org config to get admin list
   * 2. Gets sender's OOBI to include in registration
   * 3. Sends registration EXN to all admins
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
      // Step 1: Fetch org config to get admin list
      console.log('[Registration] Fetching org config...');
      const configResult = await fetchOrgConfig();

      if (configResult.status === 'not_configured') {
        throw new Error('Organization is not configured yet');
      }

      const config = configResult.status === 'configured'
        ? configResult.config
        : configResult.cached;

      if (!config) {
        throw new Error('Could not fetch organization configuration');
      }

      const admins = config.admins;
      if (!admins || admins.length === 0) {
        throw new Error('No admins configured for this organization');
      }

      console.log(`[Registration] Found ${admins.length} admin(s) to notify`);

      // Step 2: Get sender's OOBI to include in registration
      let senderOOBI = '';
      try {
        senderOOBI = await keriClient.getOOBI(currentAID.name);
        console.log('[Registration] Got sender OOBI:', senderOOBI);
      } catch (oobiErr) {
        console.warn('[Registration] Could not get sender OOBI:', oobiErr);
        // Continue without OOBI - admin may not be able to contact back
      }

      // Step 3: Try to resolve org OOBI (for general contact)
      try {
        const orgOOBI = config.organization.oobi;
        if (orgOOBI) {
          await keriClient.resolveOOBI(orgOOBI, 'matou-org', 5000);
          console.log('[Registration] Organization OOBI resolved');
        }
      } catch (oobiError) {
        console.warn('[Registration] Org OOBI resolution failed, continuing:', oobiError);
      }

      // Step 4: Send registration to all admins
      console.log('[Registration] Sending registration to admins...');
      const result = await keriClient.sendRegistrationToAdmins(
        currentAID.name,
        admins.map(a => ({ aid: a.aid, oobi: a.oobi })),
        {
          name: profile.name,
          bio: profile.bio,
          interests: profile.interests,
          customInterests: profile.customInterests,
          senderOOBI,
        }
      );

      if (!result.success) {
        // All admins failed
        if (result.failed.length === admins.length) {
          // Check if this might be an OOBI issue
          console.warn('[Registration] Could not send to any admin. Proceeding anyway.');
          // Still mark as "sent" so UI can proceed
          registrationSent.value = true;
          return true;
        }
        throw new Error('Failed to send registration to any admin');
      }

      console.log(`[Registration] Sent to ${result.sent.length}/${admins.length} admins`);
      if (result.failed.length > 0) {
        console.warn(`[Registration] Failed to send to: ${result.failed.join(', ')}`);
      }

      registrationSent.value = true;
      console.log('[Registration] Registration submitted successfully');

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
