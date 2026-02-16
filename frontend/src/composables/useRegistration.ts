/**
 * Composable for handling user registration with the organization
 * Sends an EXN message to all admins to establish OOBI exchange and submit registration
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { useOnboardingStore } from 'stores/onboarding';
import { fetchOrgConfig } from 'src/api/config';
import { setBackendIdentity, sendRegistrationSubmittedNotification } from 'src/lib/api/client';
import { useAppStore } from 'stores/app';
import { secureStorage } from 'src/lib/secureStorage';

export interface RegistrationData {
  name: string;
  email?: string;
  bio: string;
  location?: string;
  joinReason?: string;
  indigenousCommunity?: string;
  facebookUrl?: string;
  linkedinUrl?: string;
  twitterUrl?: string;
  instagramUrl?: string;
  githubUrl?: string;
  gitlabUrl?: string;
  interests: string[];
  customInterests?: string;
  avatarFileRef?: string;
  /** Base64-encoded avatar image data (for inclusion in registration message) */
  avatarData?: string;
  /** MIME type of the avatar image */
  avatarMimeType?: string;
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

      // Step 2: Get sender's OOBI to include in registration (required for credential delivery)
      let senderOOBI = '';
      try {
        senderOOBI = await keriClient.getOOBI(currentAID.prefix);
        console.log('[Registration] Got sender OOBI:', senderOOBI);
      } catch (oobiErr) {
        console.error('[Registration] Could not get sender OOBI:', oobiErr);
        throw new Error('Could not generate your OOBI — the admin needs this to deliver your credential. Please ensure KERIA is running and try again.');
      }
      if (!senderOOBI) {
        throw new Error('Generated OOBI is empty — cannot register without a valid OOBI for credential delivery.');
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
        currentAID.prefix,
        admins.map(a => ({ aid: a.aid, oobi: a.oobi })),
        {
          name: profile.name,
          email: profile.email,
          bio: profile.bio,
          location: profile.location,
          joinReason: profile.joinReason,
          indigenousCommunity: profile.indigenousCommunity,
          facebookUrl: profile.facebookUrl,
          linkedinUrl: profile.linkedinUrl,
          twitterUrl: profile.twitterUrl,
          instagramUrl: profile.instagramUrl,
          githubUrl: profile.githubUrl,
          gitlabUrl: profile.gitlabUrl,
          interests: profile.interests,
          customInterests: profile.customInterests,
          avatarFileRef: profile.avatarFileRef,
          avatarData: profile.avatarData,
          avatarMimeType: profile.avatarMimeType,
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

      // Step 5: Set backend identity (derives peer key, restarts SDK, creates private space)
      try {
        const mnemonicWords = onboardingStore.mnemonic.words;
        if (mnemonicWords.length > 0) {
          const mnemonicStr = mnemonicWords.join(' ');
          await secureStorage.setItem('matou_mnemonic', mnemonicStr);

          const appStore = useAppStore();
          const identityResult = await setBackendIdentity({
            aid: currentAID.prefix,
            mnemonic: mnemonicStr,
            orgAid: appStore.orgAid ?? undefined,
            communitySpaceId: appStore.orgConfig?.communitySpaceId ?? undefined,
            mode: 'claim',
          });
          if (identityResult.success) {
            console.log('[Registration] Backend identity set, peer:', identityResult.peerId,
              'private space:', identityResult.privateSpaceId);
          } else {
            console.warn('[Registration] Backend identity set failed:', identityResult.error);
          }
        }
      } catch (err) {
        // Non-fatal - identity can be set later
        console.warn('[Registration] Backend identity configuration deferred:', err);
      }

      // Step 6: Notify onboarding team (non-blocking)
      try {
        await sendRegistrationSubmittedNotification({
          applicantName: profile.name,
          applicantEmail: profile.email || undefined,
          applicantAid: currentAID.prefix,
          bio: profile.bio,
          location: profile.location || undefined,
          joinReason: profile.joinReason || undefined,
          interests: profile.interests,
          customInterests: profile.customInterests || undefined,
          submittedAt: new Date().toISOString(),
        });
      } catch (notifyErr) {
        console.warn('[Registration] Onboarding notification deferred:', notifyErr);
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
        currentAID.prefix,
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
