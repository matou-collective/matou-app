/**
 * Composable for admin actions on registrations
 * Provides approve, decline, and message functionality
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { fetchOrgConfig } from 'src/api/config';
import type { PendingRegistration } from './useRegistrationPolling';

// Membership credential schema
const MEMBERSHIP_SCHEMA_SAID = 'EMembershipSchemaV1';

export function useAdminActions() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();

  // State
  const isProcessing = ref(false);
  const error = ref<string | null>(null);
  const lastAction = ref<{ type: string; success: boolean; registrationId: string } | null>(null);

  /**
   * Get the org AID name for issuing credentials
   * This should match the AID that owns the registry
   */
  async function getOrgAidName(): Promise<string> {
    // The org AID name used for credential issuance
    // This is typically set up during org setup
    const aids = await keriClient.getSignifyClient()?.identifiers().list();
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
      const credentialData = {
        communityName: config.organization.name,
        memberName: registration.profile.name,
        role: 'Member',
        permissions: ['participate', 'vote', 'propose'],
        joinedAt: new Date().toISOString(),
        interests: registration.profile.interests,
      };

      console.log('[AdminActions] Issuing membership credential to:', registration.applicantAid);
      const credResult = await keriClient.issueCredential(
        issuerAidName,
        config.registry.id,
        MEMBERSHIP_SCHEMA_SAID,
        registration.applicantAid,
        credentialData
      );

      console.log('[AdminActions] Credential issued:', credResult.said);

      // 5. Mark notification as read
      await keriClient.markNotificationRead(registration.notificationId);

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

      // 3. Mark notification as read
      await keriClient.markNotificationRead(registration.notificationId);

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
