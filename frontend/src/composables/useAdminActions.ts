/**
 * Composable for admin actions on registrations
 * Provides approve, decline, and message functionality
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { fetchOrgConfig } from 'src/api/config';
import type { PendingRegistration } from './useRegistrationPolling';
import { BACKEND_URL, createOrUpdateProfile, initMemberProfiles, sendRegistrationApprovedNotification, removeMember as removeMemberAPI } from 'src/lib/api/client';
import { secureStorage } from 'src/lib/secureStorage';

// Membership credential schema
export const MEMBERSHIP_SCHEMA_SAID = 'ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI';
export const ENDORSEMENT_SCHEMA_SAID = 'EIefouRuIuoi9ZtnW3BOCSVeXQSt8k3uJLvmYHfvNPOE';
export const EVENT_ATTENDANCE_SCHEMA_SAID = 'ELhtmIAF5uZp40VJ08P7LJ_A4JH53ybWdvkSA3L-Sw2J';

export function useAdminActions() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();

  // State
  const isProcessing = ref(false);
  const processingRegistrationId = ref<string | null>(null);
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

    // First: check org config for the canonical org AID prefix
    try {
      const configResult = await fetchOrgConfig();
      const config = configResult.status === 'configured'
        ? configResult.config
        : configResult.status === 'server_unreachable'
          ? configResult.cached
          : null;

      if (config?.organization?.aid) {
        const aids = await client.identifiers().list();
        const orgAid = aids.aids?.find(
          (a: { prefix: string }) => a.prefix === config.organization.aid
        );
        if (orgAid) {
          console.log('[AdminActions] Using org AID from config:', orgAid.name);
          return orgAid.prefix;
        }
      }
    } catch {
      // Fall through to other methods
    }

    // Second: check secure storage (set during org setup or multisig join)
    const storedOrgAid = await secureStorage.getItem('matou_org_aid');
    if (storedOrgAid) {
      const aids = await client.identifiers().list();
      const orgAid = aids.aids?.find((a: { prefix: string }) => a.prefix === storedOrgAid);
      if (orgAid) {
        console.log('[AdminActions] Using stored org AID:', orgAid.name);
        return orgAid.prefix;
      }
    }

    // Fallback: look for an org-type AID by name pattern
    const aids = await client.identifiers().list();
    if (!aids?.aids?.length) {
      throw new Error('No AIDs found in wallet');
    }

    const orgAid = aids.aids.find((a: { name: string }) =>
      a.name.includes('org') || a.name.includes('matou') || a.name.includes('community')
    );

    if (orgAid) {
      return orgAid.prefix;
    }

    return aids.aids[0].prefix;
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
    processingRegistrationId.value = registration.notificationId;
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

      // 2. Resolve applicant OOBI (required for IPEX grant delivery)
      let applicantOOBI = registration.applicantOOBI;
      if (!applicantOOBI) {
        // Fallback: construct OOBI from KERIA CESR URL + applicant AID
        const cesrUrl = keriClient.getCesrUrl();
        if (cesrUrl && registration.applicantAid) {
          applicantOOBI = `${cesrUrl}/oobi/${registration.applicantAid}`;
          console.log(`[AdminActions] Constructed fallback OOBI: ${applicantOOBI}`);
        } else {
          throw new Error('Cannot issue credential: applicant OOBI is missing and could not construct fallback. The applicant may need to re-register.');
        }
      }
      const oobiResolved = await keriClient.resolveOOBI(applicantOOBI, undefined, 30000);
      if (!oobiResolved) {
        throw new Error('Could not resolve applicant OOBI — unable to deliver credential. Please check that KERIA is running and try again.');
      }
      console.log('[AdminActions] Resolved applicant OOBI');

      // 3. Get the issuing AID name
      const issuerAidName = await getOrgAidName();
      console.log(`[AdminActions] Issuing credential from AID: ${issuerAidName}`);

      // 4. Initialize member profiles FIRST — ensures profiles are in the sync
      //    node before the member receives the invite and joins the space.
      //    This eliminates the race condition where the member joins before
      //    their profiles are synced.
      let credentialSaid = 'pending'; // Updated after credential issuance
      const initResult = await initMemberProfiles({
        memberAid: registration.applicantAid,
        credentialSaid: credentialSaid,
        role: 'Member',
        displayName: registration.profile?.name,
        email: registration.profile?.email,
        avatar: registration.profile?.avatarFileRef,
        avatarData: registration.profile?.avatarData,
        avatarMimeType: registration.profile?.avatarMimeType,
        bio: registration.profile?.bio,
        interests: registration.profile?.interests,
        customInterests: registration.profile?.customInterests,
        location: registration.profile?.location,
        indigenousCommunity: registration.profile?.indigenousCommunity,
        joinReason: registration.profile?.joinReason,
        facebookUrl: registration.profile?.facebookUrl,
        linkedinUrl: registration.profile?.linkedinUrl,
        twitterUrl: registration.profile?.twitterUrl,
        instagramUrl: registration.profile?.instagramUrl,
        githubUrl: registration.profile?.githubUrl,
        gitlabUrl: registration.profile?.gitlabUrl,
      });
      if (!initResult.success) {
        throw new Error(`Failed to initialize member profiles: ${initResult.error || 'unknown error'}`);
      }
      console.log('[AdminActions] Member profiles created for:', registration.applicantAid);

      // 5. Generate space invite so we can embed the invite data in the
      //    IPEX grant's message field (reliable delivery).
      let grantMessage = '';
      try {
        const inviteResponse = await fetch(`${BACKEND_URL}/api/v1/spaces/community/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipientAid: registration.applicantAid,
            credentialSaid: credentialSaid,
            schema: 'EMatouMembershipSchemaV1',
          }),
          signal: AbortSignal.timeout(30000),
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

      // 6. Issue membership credential
      // Note: Schema requires communityName to be 'MATOU' literal value
      const credentialData = {
        communityName: 'MATOU',
        role: 'Member',
        joinedAt: new Date().toISOString(),
      };

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
      credentialSaid = credResult.said;

      // 6b. Update CommunityProfile with real credential SAID
      //     (profiles were created in step 4 with credentialSaid='pending')
      //     Note: personal endorsement registries are created lazily by each member
      //     via useEndorsements when they first try to endorse someone.
      try {
        const profileId = `CommunityProfile-${registration.applicantAid}`;
        const now = new Date().toISOString();
        await createOrUpdateProfile('CommunityProfile', {
          userAID: registration.applicantAid,
          credential: credentialSaid,
          role: 'Member',
          credentials: [credentialSaid],
          memberSince: now,
          lastActiveAt: now,
        }, { id: profileId });
        console.log('[AdminActions] Updated CommunityProfile with credential SAID:', credentialSaid);
      } catch (updateErr) {
        console.warn('[AdminActions] Failed to update CommunityProfile with credential SAID:', updateErr);
      }

      // 7. Email approval notification (non-blocking)
      if (registration.profile?.email) {
        try {
          await sendRegistrationApprovedNotification({
            applicantEmail: registration.profile.email,
            applicantName: registration.profile.name || 'Member',
          });
        } catch (notifyErr) {
          console.warn('[AdminActions] Approval notification deferred:', notifyErr);
        }
      }

      // 8. Mark ALL notifications for this applicant as read
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
      processingRegistrationId.value = null;
    }
  }

  /**
   * Add a steward's AID to the org group AID via multisig rotation.
   * Called after changing a member's role to Founding Member or Community Steward.
   * @param stewardAid - The steward's personal AID prefix
   */
  /**
   * Upgrade a member to steward: multisig rotation + credential revoke/re-issue.
   * Reports progress via onStep callback.
   */
  async function upgradeMemberToSteward(
    stewardAid: string,
    newRole: string,
    onStep?: (step: string) => void,
  ): Promise<boolean> {
    const client = keriClient.getSignifyClient();
    if (!client) {
      console.error('[AdminActions] No SignifyClient for steward upgrade');
      return false;
    }

    try {
      // --- Step 1: Resolve steward identity ---
      onStep?.('Resolving steward identity...');
      console.log(`[AdminActions] Adding steward ${stewardAid.slice(0, 12)}... to org multisig`);

      const orgAidPrefix = await getOrgAidName();
      const aids = await client.identifiers().list();
      const orgAid = aids.aids?.find((a: { prefix: string }) => a.prefix === orgAidPrefix);
      const orgName = orgAid?.name;
      if (!orgName) throw new Error('Could not find org AID name');

      const personalAid = aids.aids?.find((a: { prefix: string; name: string }) =>
        a.prefix !== orgAidPrefix && !a.name?.includes('org')
      );
      if (!personalAid) throw new Error('Could not find admin personal AID');

      const cesrUrl = keriClient.getCesrUrl();
      const stewardOOBI = `${cesrUrl}/oobi/${stewardAid}`;
      await keriClient.resolveOOBI(stewardOOBI, undefined, 30000);

      // --- Step 2: Key rotation ---
      onStep?.('Performing key rotation...');
      await keriClient.addMemberToGroup(orgName, stewardAid, personalAid.name);
      console.log('[AdminActions] Steward added to org multisig');

      // --- Step 3: Revoke old credential ---
      onStep?.('Revoking old credential...');
      const configResult = await fetchOrgConfig();
      if (configResult.status !== 'configured') throw new Error('Org config not available');
      const config = configResult.config;
      if (!config.registry?.id) throw new Error('Registry not found in org config');
      const creds = await client.credentials().list();
      const oldCred = creds.find(
        (c: { sad: { s: string; a?: { i?: string } } }) =>
          c.sad.s === MEMBERSHIP_SCHEMA_SAID && c.sad.a?.i === stewardAid
      );
      if (oldCred) {
        await keriClient.revokeCredential(orgAid!.prefix, oldCred.sad.d);
        console.log('[AdminActions] Old credential revoked:', oldCred.sad.d);
      } else {
        console.warn('[AdminActions] No existing membership credential found to revoke');
      }

      // --- Step 4: Issue new credential with updated role ---
      onStep?.('Issuing new credential...');
      const grantMessage = `Role updated to ${newRole}`;
      const credResult = await keriClient.issueCredential(
        orgName,
        config.registry.id,
        MEMBERSHIP_SCHEMA_SAID,
        stewardAid,
        {
          communityName: 'MATOU',
          role: newRole,
          joinedAt: new Date().toISOString(),
        },
        grantMessage,
      );
      console.log('[AdminActions] New credential issued:', credResult.said);

      // Update CommunityProfile with new credential SAID
      const profileId = `CommunityProfile-${stewardAid}`;
      const now = new Date().toISOString();
      await createOrUpdateProfile('CommunityProfile', {
        userAID: stewardAid,
        credential: credResult.said,
        role: newRole,
        credentials: oldCred ? [oldCred.sad.d, credResult.said] : [credResult.said],
        memberSince: now,
        lastActiveAt: now,
      }, { id: profileId });

      onStep?.('Complete');
      console.log('[AdminActions] Steward upgrade complete');
      return true;
    } catch (err) {
      console.error('[AdminActions] Failed to upgrade steward:', err);
      return false;
    }
  }

  /** @deprecated Use upgradeMemberToSteward instead */
  async function addStewardToOrgMultisig(stewardAid: string): Promise<boolean> {
    return upgradeMemberToSteward(stewardAid, 'Community Steward');
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
    processingRegistrationId.value = registration.notificationId;
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
        currentAID.prefix,
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

      // 4. Update SharedProfile status to declined
      const profileId = `SharedProfile-${registration.applicantAid}`;
      try {
        await createOrUpdateProfile('SharedProfile', { status: 'declined' }, { id: profileId });
        console.log('[AdminActions] Updated SharedProfile status to declined for:', registration.applicantAid);
      } catch (profileErr) {
        console.warn('[AdminActions] Failed to update SharedProfile status to declined:', profileErr);
      }

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
      processingRegistrationId.value = null;
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
        currentAID.prefix,
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
   * Remove a member: revoke their membership credential and soft-delete their profiles.
   * @param memberAid - The member's AID prefix
   * @param credentialSaid - The member's credential SAID (optional; will search if omitted)
   * @param reason - Optional removal reason
   * @param onStep - Optional progress callback
   * @returns Success status
   */
  async function removeMember(
    memberAid: string,
    credentialSaid: string,
    reason?: string,
    onStep?: (step: string) => void,
  ): Promise<boolean> {
    if (isProcessing.value) {
      console.warn('[AdminActions] Already processing an action');
      return false;
    }

    isProcessing.value = true;
    error.value = null;

    try {
      const client = keriClient.getSignifyClient();
      if (!client) throw new Error('Not connected to KERIA');

      // --- Step 1: Resolve the org AID ---
      onStep?.('Resolving org identity...');
      const orgAidPrefix = await getOrgAidName();

      // --- Step 2: Find and revoke the credential ---
      onStep?.('Revoking credential...');
      let saidToRevoke = credentialSaid;

      if (!saidToRevoke) {
        // Search for the member's credential by schema + subject AID
        const creds = await client.credentials().list();
        const memberCred = creds.find(
          (c: { sad: { s: string; a?: { i?: string } } }) =>
            c.sad.s === MEMBERSHIP_SCHEMA_SAID && c.sad.a?.i === memberAid
        );
        if (memberCred) {
          saidToRevoke = memberCred.sad.d;
          console.log('[AdminActions] Found credential to revoke:', saidToRevoke);
        } else {
          console.warn('[AdminActions] No membership credential found for member:', memberAid);
        }
      }

      if (saidToRevoke) {
        await keriClient.revokeCredential(orgAidPrefix, saidToRevoke);
        console.log('[AdminActions] Credential revoked:', saidToRevoke);
      }

      // --- Step 3: Soft-delete profiles on the backend ---
      onStep?.('Removing member profiles...');
      const removeResult = await removeMemberAPI(memberAid, reason);
      if (!removeResult.success) {
        throw new Error(removeResult.error || 'Failed to remove member profiles');
      }
      console.log('[AdminActions] Member profiles removed for:', memberAid);

      onStep?.('Complete');
      lastAction.value = {
        type: 'remove',
        success: true,
        registrationId: memberAid,
      };

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[AdminActions] Remove member failed:', err);
      error.value = errorMsg;

      lastAction.value = {
        type: 'remove',
        success: false,
        registrationId: memberAid,
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
    processingRegistrationId,
    error,
    lastAction,

    // Actions
    approveRegistration,
    addStewardToOrgMultisig,
    upgradeMemberToSteward,
    declineRegistration,
    sendMessageToApplicant,
    removeMember,
    clearError,
  };
}
