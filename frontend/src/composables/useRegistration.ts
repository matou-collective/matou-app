/**
 * Composable for handling user registration with the organization
 * Sends an EXN message to all admins to establish OOBI exchange and submit registration
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { useOnboardingStore } from 'stores/onboarding';
import { fetchOrgConfig } from 'src/api/config';
import { BACKEND_URL } from 'src/lib/api/client';

export interface RegistrationData {
  name: string;
  bio: string;
  interests: string[];
  customInterests?: string;
}

export function useRegistration() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();
  const onboardingStore = useOnboardingStore();

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
      console.log('[Registration] Admin details:', JSON.stringify(admins, null, 2));

      // Step 2: Get sender's OOBI to include in registration
      let senderOOBI = '';
      try {
        senderOOBI = await keriClient.getOOBI(currentAID.name);
        console.log('[Registration] Got sender OOBI:', senderOOBI);
      } catch (oobiErr) {
        console.warn('[Registration] Could not get sender OOBI:', oobiErr);
        // Continue without OOBI - admin may not be able to contact back
      }

      // Step 3: Resolve org OOBI (required for credential delivery)
      try {
        const orgOOBI = config.organization.oobi;
        if (orgOOBI) {
          await keriClient.resolveOOBI(orgOOBI, 'matou-org', 30000);
          console.log('[Registration] Organization OOBI resolved');
        }
      } catch (oobiError) {
        console.warn('[Registration] Org OOBI resolution failed, continuing:', oobiError);
      }

      // Step 4: Send registration to all admins
      // Uses both custom EXN (for our patch) and IPEX apply (native KERIA support)
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
        if (result.failed.length === admins.length) {
          throw new Error('Could not deliver registration to any admin. Please try again.');
        }
        throw new Error('Failed to send registration to any admin');
      }

      console.log(`[Registration] Sent to ${result.sent.length}/${admins.length} admins`);
      if (result.failed.length > 0) {
        console.warn(`[Registration] Failed to send to: ${result.failed.join(', ')}`);
      }

      registrationSent.value = true;
      console.log('[Registration] Registration submitted successfully');

      // Step 5: Create private space (non-blocking)
      try {
        const mnemonicWords = onboardingStore.mnemonic.words;
        const spaceBody: Record<string, string> = {
          userAid: currentAID.prefix,
        };
        if (mnemonicWords.length > 0) {
          spaceBody.mnemonic = mnemonicWords.join(' ');
        }

        const spaceResponse = await fetch(`${BACKEND_URL}/api/v1/spaces/private`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(spaceBody),
          signal: AbortSignal.timeout(10000),
        });

        if (spaceResponse.ok) {
          const spaceResult = await spaceResponse.json() as { spaceId: string; created: boolean };
          console.log('[Registration] Private space created:', spaceResult.spaceId, spaceResult.created ? '(new)' : '(existing)');
        } else {
          console.warn('[Registration] Private space creation failed:', await spaceResponse.text());
        }
      } catch (err) {
        // Non-fatal - space can be created later when credentials are synced
        console.warn('[Registration] Private space creation deferred:', err);
      }

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
   * Send a reply message to an admin
   * Used when applicant wants to respond to admin messages
   *
   * @param message - The message content
   * @param adminAid - The AID of the admin to reply to
   * @param replyingTo - The previous message being replied to (for threading)
   * @returns Success status
   */
  async function sendMessageToAdmin(
    message: string,
    adminAid: string,
    replyingTo?: { id: string; content: string; sentAt: string }
  ): Promise<boolean> {
    const currentAID = identityStore.currentAID;
    if (!currentAID) {
      error.value = 'No AID found';
      return false;
    }

    isSubmitting.value = true;
    error.value = null;

    try {
      // Admin OOBI was already resolved during registration submission
      const result = await keriClient.sendEXN(
        currentAID.name,
        adminAid,
        '/matou/registration/message_reply',
        {
          type: 'message_reply',
          content: message,
          sentAt: new Date().toISOString(),
          // Include previous message for threading
          replyingTo: replyingTo ? {
            messageId: replyingTo.id,
            content: replyingTo.content,
            sentAt: replyingTo.sentAt,
          } : undefined,
        }
      );

      return result.success;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to send message';
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
    sendMessageToAdmin,
    reset,
  };
}
