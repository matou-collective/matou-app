/**
 * Composable for admin actions on registrations
 * Provides approve, decline, and message functionality
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { fetchOrgConfig } from 'src/api/config';
import type { PendingRegistration } from './useRegistrationPolling';
import { BACKEND_URL, initMemberProfiles } from 'src/lib/api/client';
import { secureStorage } from 'src/lib/secureStorage';

// Membership credential schema
const MEMBERSHIP_SCHEMA_SAID = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT';

export function useAdminActions() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();

  // State
  const isProcessing = ref(false);
  const error = ref<string | null>(null);
  const lastAction = ref<{ type: string; success: boolean; registrationId: string } | null>(null);

  /**
   * Mark all notifications for a given applicant as read
   * This handles the case where both IPEX and custom EXN notifications exist
   */
  async function markAllApplicantNotificationsRead(applicantAid: string): Promise<void> {
    try {
      // List all unread notifications
      const allNotes = await keriClient.listNotifications({ read: false });

      // Find notifications from this applicant
      for (const note of allNotes) {
        const attrs = note.a || {};
        const route = attrs.r || '';

        // Check sender AID in notification attributes
        // For pending: attrs.i is the sender
        // For verified: need to check attrs.a.i (embedded) or fetch exchange
        const senderAid = attrs.i || '';
        const embeddedSender = attrs.a?.i || '';

        if (senderAid === applicantAid || embeddedSender === applicantAid) {
          try {
            await keriClient.markNotificationRead(note.i);
            console.log(`[AdminActions] Marked notification ${note.i} as read (applicant: ${applicantAid.slice(0, 12)}...)`);
          } catch (markErr) {
            console.warn(`[AdminActions] Failed to mark notification ${note.i} as read:`, markErr);
          }
          continue;
        }

        // For verified notifications, may need to fetch exchange to get sender
        if (attrs.d && route.includes('/matou/registration/')) {
          try {
            const exchange = await keriClient.getExchange(attrs.d);
            if (exchange?.exn?.i === applicantAid) {
              await keriClient.markNotificationRead(note.i);
              console.log(`[AdminActions] Marked verified notification ${note.i} as read (applicant: ${applicantAid.slice(0, 12)}...)`);
            }
          } catch {
            // Ignore errors fetching exchange
          }
        }
      }
    } catch (err) {
      console.warn('[AdminActions] Failed to mark all applicant notifications as read:', err);
    }
  }

  /**
   * Get the org AID name for issuing credentials
   * This should match the AID that owns the registry
   */
  async function getOrgAidName(): Promise<string> {
    const client = keriClient.getSignifyClient();
    if (!client) throw new Error('Not connected to KERIA');

    // First check secure storage (set during org setup)
    const storedOrgAid = await secureStorage.getItem('matou_org_aid');
    if (storedOrgAid) {
      const aids = await client.identifiers().list();
      const orgAid = aids.aids?.find((a: { prefix: string }) => a.prefix === storedOrgAid);
      if (orgAid) {
        console.log('[AdminActions] Using stored org AID:', orgAid.name);
        return orgAid.name;
      }
    }

    // Fallback: look for an org-type AID by name pattern
    const aids = await client.identifiers().list();
    if (!aids?.aids?.length) {
      throw new Error('No AIDs found in wallet');
    }

    // Look for an org-type AID (group AID or one named with org prefix)
    const orgAid = aids.aids.find((a: { name: string }) =>
      a.name.includes('org') || a.name.includes('matou') || a.name.includes('community')
    );

    if (orgAid) {
      return orgAid.name;
    }

    // Fall back to first AID (admin's personal AID might be issuing)
    return aids.aids[0].name;
  }

  /**
   * Approve a registration and issue membership credential
   * @param registration - The registration to approve
   * @returns Success status
   */
  async function approveRegistration(registration: PendingRegistration): Promise<boolean> {
    if (isProcessing.value) {
      console.warn('[AdminActions] Already processing an action');
      return false;
    }

    isProcessing.value = true;
    error.value = null;

    try {
      const client = keriClient.getSignifyClient();
      if (!client) {
        throw new Error('Not connected to KERIA');
      }

      // 1. Get org config for registry ID
      const configResult = await fetchOrgConfig();
      if (configResult.status === 'not_configured') {
        throw new Error('Organization not configured');
      }

      const config = configResult.status === 'configured'
        ? configResult.config
        : configResult.cached;

      if (!config?.registry?.id) {
        throw new Error('No registry configured for credential issuance');
      }

      // 2. Resolve applicant OOBI if provided (so we can send them the credential)
      if (registration.applicantOOBI) {
        try {
          await keriClient.resolveOOBI(registration.applicantOOBI, undefined, 10000);
          console.log('[AdminActions] Resolved applicant OOBI');
        } catch (oobiErr) {
          console.warn('[AdminActions] Could not resolve applicant OOBI:', oobiErr);
          // Continue anyway - might already be resolved
        }
      }

      // 3. Get the issuing AID name
      const issuerAidName = await getOrgAidName();
      console.log(`[AdminActions] Issuing credential from AID: ${issuerAidName}`);

      // 4. Issue membership credential
      // Note: Schema requires communityName to be 'MATOU' literal value
      // verificationStatus must be one of: unverified, community_verified, identity_verified, expert_verified
      const credentialData = {
        communityName: 'MATOU',
        role: 'Member',
        verificationStatus: 'community_verified',
        permissions: ['participate', 'vote', 'propose'],
        joinedAt: new Date().toISOString(),
      };

      // 4b. Generate space invite BEFORE issuing credential so we can embed
      //     the invite data in the IPEX grant's message field (reliable delivery).
      let grantMessage = '';
      try {
        const inviteResponse = await fetch(`${BACKEND_URL}/api/v1/spaces/community/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipientAid: registration.applicantAid,
            credentialSaid: 'pending',
            schema: 'EMatouMembershipSchemaV1',
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (inviteResponse.ok) {
          const inviteResult = await inviteResponse.json() as {
            success: boolean;
            communitySpaceId?: string;
            inviteKey?: string;
            readOnlyInviteKey?: string;
            readOnlySpaceId?: string;
          };
          console.log('[AdminActions] Invite generated:', inviteResult);

          if (inviteResult.inviteKey) {
            // Embed invite data in the IPEX grant message for reliable delivery
            grantMessage = JSON.stringify({
              type: 'space_invite',
              spaceId: inviteResult.communitySpaceId,
              inviteKey: inviteResult.inviteKey,
              readOnlyInviteKey: inviteResult.readOnlyInviteKey,
              readOnlySpaceId: inviteResult.readOnlySpaceId,
            });
          }
        } else {
          console.warn('[AdminActions] Space invitation failed:', await inviteResponse.text());
        }
      } catch (inviteErr) {
        console.warn('[AdminActions] Space invitation deferred:', inviteErr);
      }

      console.log('[AdminActions] Issuing membership credential to:', registration.applicantAid);
      const credResult = await keriClient.issueCredential(
        issuerAidName,
        config.registry.id,
        MEMBERSHIP_SCHEMA_SAID,
        registration.applicantAid,
        credentialData,
        grantMessage
      );

      console.log('[AdminActions] Credential issued:', credResult.said);

      // 5b. Initialize member's CommunityProfile in read-only space
      try {
        const initResult = await initMemberProfiles({
          memberAid: registration.applicantAid,
          credentialSaid: credResult.said,
          role: 'Member',
          displayName: registration.profile?.name,
          email: registration.profile?.email,
          avatar: registration.profile?.avatarFileRef,
          bio: registration.profile?.bio,
          interests: registration.profile?.interests,
        });
        if (initResult.success) {
          console.log('[AdminActions] CommunityProfile created for:', registration.applicantAid);
        } else {
          console.warn('[AdminActions] Failed to init member profiles:', initResult.error);
        }
      } catch (initErr) {
        console.warn('[AdminActions] Failed to init member profiles:', initErr);
      }

      // 6. Mark ALL notifications for this applicant as read
      // (handles both IPEX and custom EXN notifications)
      await markAllApplicantNotificationsRead(registration.applicantAid);

      lastAction.value = {
        type: 'approve',
        success: true,
        registrationId: registration.notificationId,
      };

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[AdminActions] Approve failed:', err);
      error.value = errorMsg;

      lastAction.value = {
        type: 'approve',
        success: false,
        registrationId: registration.notificationId,
      };

      return false;
    } finally {
      isProcessing.value = false;
    }
  }

  /**
   * Decline a registration and send rejection notification
   * @param registration - The registration to decline
   * @param reason - Optional reason for decline
   * @returns Success status
   */
  async function declineRegistration(
    registration: PendingRegistration,
    reason?: string
  ): Promise<boolean> {
    if (isProcessing.value) {
      console.warn('[AdminActions] Already processing an action');
      return false;
    }

    isProcessing.value = true;
    error.value = null;

    try {
      const currentAID = identityStore.currentAID;
      if (!currentAID) {
        throw new Error('No identity found');
      }

      // 1. Resolve applicant OOBI if provided
      if (registration.applicantOOBI) {
        try {
          await keriClient.resolveOOBI(registration.applicantOOBI, undefined, 10000);
          console.log('[AdminActions] Resolved applicant OOBI');
        } catch (oobiErr) {
          console.warn('[AdminActions] Could not resolve applicant OOBI:', oobiErr);
        }
      }

      // 2. Send rejection EXN
      const payload = {
        type: 'rejection',
        reason: reason || 'Your registration has been declined.',
        declinedAt: new Date().toISOString(),
        originalRegistration: registration.exnSaid,
      };

      console.log('[AdminActions] Sending decline notification to:', registration.applicantAid);
      const result = await keriClient.sendEXN(
        currentAID.name,
        registration.applicantAid,
        '/matou/registration/decline',
        payload
      );

      if (!result.success) {
        console.warn('[AdminActions] Could not send decline notification:', result.error);
        // Continue anyway - still mark as processed
      }

      // 3. Mark ALL notifications for this applicant as read
      // (handles both IPEX and custom EXN notifications)
      await markAllApplicantNotificationsRead(registration.applicantAid);

      lastAction.value = {
        type: 'decline',
        success: true,
        registrationId: registration.notificationId,
      };

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[AdminActions] Decline failed:', err);
      error.value = errorMsg;

      lastAction.value = {
        type: 'decline',
        success: false,
        registrationId: registration.notificationId,
      };

      return false;
    } finally {
      isProcessing.value = false;
    }
  }

  /**
   * Send a message to an applicant
   * @param registration - The registration to message
   * @param message - The message content
   * @returns Success status
   */
  async function sendMessageToApplicant(
    registration: PendingRegistration,
    message: string
  ): Promise<boolean> {
    if (isProcessing.value) {
      console.warn('[AdminActions] Already processing an action');
      return false;
    }

    isProcessing.value = true;
    error.value = null;

    try {
      const currentAID = identityStore.currentAID;
      if (!currentAID) {
        throw new Error('No identity found');
      }

      // 1. Resolve applicant OOBI if provided
      if (registration.applicantOOBI) {
        try {
          await keriClient.resolveOOBI(registration.applicantOOBI, undefined, 10000);
          console.log('[AdminActions] Resolved applicant OOBI');
        } catch (oobiErr) {
          console.warn('[AdminActions] Could not resolve applicant OOBI:', oobiErr);
        }
      }

      // 2. Send message EXN
      const payload = {
        type: 'message',
        content: message,
        sentAt: new Date().toISOString(),
        regardingRegistration: registration.exnSaid,
      };

      console.log('[AdminActions] Sending message to:', registration.applicantAid);
      const result = await keriClient.sendEXN(
        currentAID.name,
        registration.applicantAid,
        '/matou/registration/message',
        payload
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to send message');
      }

      lastAction.value = {
        type: 'message',
        success: true,
        registrationId: registration.notificationId,
      };

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[AdminActions] Send message failed:', err);
      error.value = errorMsg;

      lastAction.value = {
        type: 'message',
        success: false,
        registrationId: registration.notificationId,
      };

      return false;
    } finally {
      isProcessing.value = false;
    }
  }

  /**
   * Clear error state
   */
  function clearError() {
    error.value = null;
  }

  return {
    // State
    isProcessing,
    error,
    lastAction,

    // Actions
    approveRegistration,
    declineRegistration,
    sendMessageToApplicant,
    clearError,
  };
}
