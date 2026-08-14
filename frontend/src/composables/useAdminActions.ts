/**
 * Composable for admin actions on registrations
 * Provides approve, decline, and message functionality
 */
import { ref } from 'vue';
import { Notify } from 'quasar';
import { useKERIClient } from 'src/lib/keri/client';
import { isLikelyCredentialSaid } from 'src/lib/keri/said';
import { useIdentityStore } from 'stores/identity';
import { fetchOrgConfig } from 'src/api/config';
import type { PendingRegistration } from './useRegistrationPolling';
import { buildOobiCandidates } from 'src/lib/registrationResolve';
import { BACKEND_URL, createOrUpdateProfile, getProfileById, grantStewardAdmin, initMemberProfiles, sendRegistrationApprovedNotification, removeMember as removeMemberAPI } from 'src/lib/api/client';
import { getOrCreateOrgRegistry } from 'src/lib/keri/registry';
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
  const processingStep = ref('');
  const error = ref<string | null>(null);
  const lastAction = ref<{ type: string; success: boolean; registrationId: string } | null>(null);

  /**
   * Surface a non-fatal post-issuance problem to the steward. The approval
   * itself succeeded (credential issued), so these must not fail the flow,
   * but silently console.warn-ing them is how broken states go unnoticed.
   */
  function notifyApprovalWarning(message: string) {
    console.warn('[AdminActions]', message);
    Notify.create({
      type: 'warning',
      message,
      timeout: 0,
      actions: [{ label: 'Dismiss', color: 'white' }],
    });
  }

  /**
   * Resolve an applicant's key state, trying every OOBI form we can build
   * (bare OOBI first — it survives agent re-boots — then the recorded
   * senderOOBI). Returns the failure reasons when nothing resolves so the
   * caller can surface WHY instead of a generic error.
   */
  async function resolveApplicant(
    registration: PendingRegistration,
    timeoutMs = 30000,
  ): Promise<{ ok: boolean; detail: string }> {
    const candidates = buildOobiCandidates({
      applicantAid: registration.applicantAid,
      recordedOobi: registration.applicantOOBI,
      cesrUrl: keriClient.getCesrUrl(),
    });
    if (candidates.length === 0) {
      return { ok: false, detail: 'no OOBI available — the applicant may need to re-register' };
    }
    const failures: string[] = [];
    for (const oobi of candidates) {
      const result = await keriClient.resolveOOBIWithReason(oobi, undefined, timeoutMs);
      if (result.ok) {
        console.log(`[AdminActions] Resolved applicant via ${oobi}`);
        return { ok: true, detail: oobi };
      }
      failures.push(`${oobi} (${result.reason || 'unknown'})`);
    }
    return { ok: false, detail: `tried ${candidates.length} OOBI form(s): ${failures.join('; ')}` };
  }

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
    processingStep.value = 'Preparing...';
    error.value = null;

    try {
      const client = keriClient.getSignifyClient();
      if (!client) {
        throw new Error('Not connected to KERIA');
      }

      // 1. Get org config for registry ID
      processingStep.value = 'Loading organisation configuration...';
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

      // 2. Resolve applicant OOBI (required for IPEX grant delivery).
      // Tries bare OOBI first, then the recorded senderOOBI — the recorded
      // agent-form OOBI goes stale when the applicant's agent is re-created.
      processingStep.value = 'Resolving applicant identity...';
      const resolved = await resolveApplicant(registration);
      if (!resolved.ok) {
        throw new Error(`Could not resolve the applicant's identity — unable to deliver credential (${resolved.detail}).`);
      }

      // 3. Get the issuing AID name
      const issuerAidName = await getOrgAidName();
      console.log(`[AdminActions] Issuing credential from AID: ${issuerAidName}`);

      // 4. Initialize member profiles FIRST — ensures profiles are in the sync
      processingStep.value = 'Creating member profiles...';
      //    node before the member receives the invite and joins the space.
      //    This eliminates the race condition where the member joins before
      //    their profiles are synced.
      let credentialSaid = 'pending'; // Updated after credential issuance
      const initResult = await initMemberProfiles({
        memberAid: registration.applicantAid,
        credentialSaid: credentialSaid,
        role: 'Member',
        // Keep the member in the pending list until issuance succeeds (6c
        // flips this to 'approved') so a failed approval can be retried.
        status: 'pending',
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
      processingStep.value = 'Generating community space invite...';
      //    IPEX grant's message field (reliable delivery).
      // The invite is the member's only path into the community space, so a
      // failure here aborts the approval BEFORE the credential is issued —
      // otherwise the member ends up credentialed but stranded at the invite
      // step of the pending screen. Nothing irreversible has happened yet;
      // the steward can simply retry.
      let grantMessage = '';
      let inviteResponse: Response;
      try {
        inviteResponse = await fetch(`${BACKEND_URL}/api/v1/spaces/community/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipientAid: registration.applicantAid,
            credentialSaid: credentialSaid,
            schema: 'EMatouMembershipSchemaV1',
          }),
          signal: AbortSignal.timeout(30000),
        });
      } catch (inviteErr) {
        const msg = inviteErr instanceof Error ? inviteErr.message : String(inviteErr);
        throw new Error(`Community space invite failed (${msg}). Approval aborted before credential issuance — please retry.`);
      }
      if (!inviteResponse.ok) {
        const body = await inviteResponse.text();
        throw new Error(`Community space invite failed (${inviteResponse.status}: ${body}). Approval aborted before credential issuance — please retry.`);
      }
      const inviteResult = await inviteResponse.json() as {
        success: boolean;
        communitySpaceId?: string;
        inviteKey?: string;
        readOnlyInviteKey?: string;
        readOnlySpaceId?: string;
      };
      console.log('[AdminActions] Invite generated:', inviteResult);
      if (!inviteResult.inviteKey) {
        throw new Error('Community space invite response contained no invite key. Approval aborted before credential issuance — please retry.');
      }
      // Embed invite data in the IPEX grant message for reliable delivery
      grantMessage = JSON.stringify({
        type: 'space_invite',
        spaceId: inviteResult.communitySpaceId,
        inviteKey: inviteResult.inviteKey,
        readOnlyInviteKey: inviteResult.readOnlyInviteKey,
        readOnlySpaceId: inviteResult.readOnlySpaceId,
      });

      // 6. Issue membership credential
      processingStep.value = 'Issuing membership credential...';
      // Note: Schema requires communityName to be 'MATOU' literal value
      const credentialData = {
        communityName: 'MATOU',
        role: 'Member',
        joinedAt: new Date().toISOString(),
      };

      console.log('[AdminActions] Issuing membership credential to:', registration.applicantAid);
      // Resolve the registry on the org group AID for THIS backend. KERIA does
      // not sync TEL/registry events between group-AID members, so each
      // steward must use a registry that exists in their local KERIA. The
      // admin already has one; upgraded stewards create their own here.
      const orgRegistryId = await getOrCreateOrgRegistry(issuerAidName);
      const credResult = await keriClient.issueCredential(
        issuerAidName,
        orgRegistryId,
        MEMBERSHIP_SCHEMA_SAID,
        registration.applicantAid,
        credentialData,
        grantMessage
      );

      console.log('[AdminActions] Credential issued:', credResult.said);
      credentialSaid = credResult.said;

      // Push the issuer's KEL (org group AID, incl. the ixn anchoring this
      // credential's registry event) into the applicant's agent. Without it
      // a credential issued by an upgraded steward sits in the applicant's
      // Verifier/Tevery escrow ("Missing anchor") until group key state
      // happens to arrive — observed at ~5.5 minutes, far past every poll
      // window. Best-effort: the applicant also re-queries key state while
      // polling.
      await keriClient.pushKelToAgent(issuerAidName, registration.applicantAid);

      // 6b. Update CommunityProfile with real credential SAID.
      //     Profiles were created in step 4 by initMemberProfiles with
      //     credentialSaid='pending' AND ~15 display fields (displayName, avatar,
      //     bio, joinReason, social URLs, etc.). createOrUpdateProfile is
      //     full-replace, so we must read existing data and merge — otherwise
      //     those display fields are wiped from the read-only space.
      //     Note: personal endorsement registries are created lazily by each member
      //     via useEndorsements when they first try to endorse someone.
      try {
        const profileId = `CommunityProfile-${registration.applicantAid}`;
        const existing = await getProfileById('CommunityProfile', profileId);
        const existingData = (existing?.data || {}) as Record<string, unknown>;
        const now = new Date().toISOString();
        const merged = {
          ...existingData,
          userAID: registration.applicantAid,
          credential: credentialSaid,
          role: 'Member',
          credentials: [credentialSaid],
          memberSince: (existingData.memberSince as string) || now,
          lastActiveAt: now,
        };
        const result = await createOrUpdateProfile('CommunityProfile', merged, { id: profileId });
        if (result.success) {
          console.log('[AdminActions] Updated CommunityProfile with credential SAID:', credentialSaid);
        } else {
          notifyApprovalWarning(`Member approved, but their profile still shows a placeholder credential (${result.error ?? 'unknown error'}).`);
        }
      } catch (updateErr) {
        notifyApprovalWarning(`Member approved, but their profile still shows a placeholder credential (${updateErr instanceof Error ? updateErr.message : String(updateErr)}).`);
      }

      // 6c. Flip SharedProfile status pending -> approved. The profile was
      //     written with status='pending' in step 4; only now that the
      //     credential exists does the member leave the pending list.
      //     createOrUpdateProfile is full-replace, so read-merge first.
      try {
        const sharedId = `SharedProfile-${registration.applicantAid}`;
        const existingShared = await getProfileById('SharedProfile', sharedId);
        const existingSharedData = (existingShared?.data || {}) as Record<string, unknown>;
        const sharedResult = await createOrUpdateProfile('SharedProfile', {
          ...existingSharedData,
          aid: registration.applicantAid,
          status: 'approved',
          updatedAt: new Date().toISOString(),
        }, { id: sharedId });
        if (sharedResult.success) {
          console.log('[AdminActions] SharedProfile status flipped to approved');
        } else {
          notifyApprovalWarning(`Member approved, but they may still appear in the pending list (${sharedResult.error ?? 'unknown error'}).`);
        }
      } catch (statusErr) {
        notifyApprovalWarning(`Member approved, but they may still appear in the pending list (${statusErr instanceof Error ? statusErr.message : String(statusErr)}).`);
      }

      // 7. Email approval notification (non-blocking)
      processingStep.value = 'Sending approval notification...';
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
      processingStep.value = 'Finalising...';
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
      processingStep.value = '';
    }
  }

  /**
   * Revoke a member's current membership credential and re-issue it with a new
   * role, then update the member's CommunityProfile (role + credential SAID).
   *
   * This is the credential-backed half of a role change (issue #20, item 3):
   * a role change is only legitimate when the membership credential is
   * re-issued, so the profile role and the credential role can never drift.
   * TEL-anchored revocation of the old credential gives the change audit +
   * revocation for free. Shared by BOTH the steward-upgrade path (which also
   * does multisig rotation) and plain non-steward role changes.
   *
   * Reports progress via onStep using the same 'Revoking old credential...' /
   * 'Issuing new credential...' messages the ChangeRoleModal stepper expects.
   *
   * @param memberAid - The member's personal AID prefix
   * @param newRole   - The role to encode in the new credential
   */
  async function reissueMembershipCredential(
    memberAid: string,
    newRole: string,
    onStep?: (step: string) => void,
  ): Promise<boolean> {
    const client = keriClient.getSignifyClient();
    if (!client) {
      console.error('[AdminActions] No SignifyClient for credential re-issue');
      return false;
    }

    // Resolve the org AID (credential issuer) and its local alias.
    const orgAidPrefix = await getOrgAidName();
    const aids = await client.identifiers().list();
    const orgAid = aids.aids?.find((a: { prefix: string }) => a.prefix === orgAidPrefix);
    const orgName = orgAid?.name;
    if (!orgName) throw new Error('Could not find org AID name');

    // Ensure KERIA can resolve the member (needed to grant them the new ACDC).
    const cesrUrl = keriClient.getCesrUrl();
    if (cesrUrl) {
      await keriClient.resolveOOBI(`${cesrUrl}/oobi/${memberAid}`, undefined, 30000);
    }

    // --- Revoke the old membership credential (TEL-anchored) ---
    processingStep.value = 'Revoking old credential...';
    onStep?.('Revoking old credential...');
    const configResult = await fetchOrgConfig();
    if (configResult.status !== 'configured') throw new Error('Org config not available');
    if (!configResult.config.registry?.id) throw new Error('Registry not found in org config');
    const creds = await client.credentials().list();
    const oldCred = creds.find(
      (c: { sad: { s: string; a?: { i?: string } } }) =>
        c.sad.s === MEMBERSHIP_SCHEMA_SAID && c.sad.a?.i === memberAid,
    );
    if (oldCred) {
      await keriClient.revokeCredential(orgAid!.prefix, oldCred.sad.d);
      console.log('[AdminActions] Old credential revoked:', oldCred.sad.d);
    } else {
      console.warn('[AdminActions] No existing membership credential found to revoke');
    }

    // --- Issue a new membership credential carrying the new role ---
    processingStep.value = 'Issuing new credential...';
    onStep?.('Issuing new credential...');
    const orgRegistryId = await getOrCreateOrgRegistry(orgName);
    const credResult = await keriClient.issueCredential(
      orgName,
      orgRegistryId,
      MEMBERSHIP_SCHEMA_SAID,
      memberAid,
      {
        communityName: 'MATOU',
        role: newRole,
        joinedAt: new Date().toISOString(),
      },
      `Role updated to ${newRole}`,
    );
    console.log('[AdminActions] New credential issued:', credResult.said);

    // Update CommunityProfile with the new credential SAID + role. Read the
    // existing profile first (createOrUpdateProfile is full-replace) so display
    // fields and the original memberSince survive.
    const profileId = `CommunityProfile-${memberAid}`;
    const existing = await getProfileById('CommunityProfile', profileId);
    const existingData = (existing?.data || {}) as Record<string, unknown>;
    const now = new Date().toISOString();
    const priorCredentials = Array.isArray(existingData.credentials)
      ? (existingData.credentials as string[])
      : [];
    const merged = {
      ...existingData,
      userAID: memberAid,
      credential: credResult.said,
      role: newRole,
      credentials: [...priorCredentials, credResult.said].filter(
        (v, i, arr) => arr.indexOf(v) === i,
      ),
      memberSince: (existingData.memberSince as string) || now,
      lastActiveAt: now,
    };
    await createOrUpdateProfile('CommunityProfile', merged, { id: profileId });
    return true;
  }

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

    isProcessing.value = true;
    processingStep.value = 'Preparing...';

    try {
      // --- Step 1: Resolve steward identity ---
      processingStep.value = 'Resolving steward identity...';
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

      // Capture the steward's current sn BEFORE round 1. The steward rotates
      // their personal AID exactly once (in response to round 1), so the
      // expected sn afterwards is current + 1. We must NOT hardcode '1': a
      // steward who already rotated during onboarding starts at sn >= 1, so a
      // fixed '1' makes waitForMemberRotation return immediately (the rotation
      // hasn't actually happened yet) and round 2 then commits the stale
      // pre-rotation key — the cause of the flaky "Invalid signing index = -1".
      const snOp = await client.keyStates().query(stewardAid, undefined, undefined);
      const snRes = await client.operations().wait(snOp, { signal: AbortSignal.timeout(30000) });
      const stewardSn0 = parseInt(((snRes.response as { s?: string })?.s ?? '0'), 16);
      const expectedStewardSn = (stewardSn0 + 1).toString(16);
      console.log(`[AdminActions] steward at sn=${stewardSn0}; expecting sn=${expectedStewardSn} after round-1 rotation`);

      // --- Step 2a: Round 1 — admin pre-rotates, group rotation adds member to rstates ---
      processingStep.value = 'Inviting steward (round 1)...';
      onStep?.('Inviting steward (round 1)...');
      await keriClient.addMemberRound1(orgName, stewardAid, personalAid.name);

      // --- Step 2b: Wait for the steward's frontend to accept and rotate ---
      processingStep.value = 'Waiting for steward to accept...';
      onStep?.('Waiting for steward to accept...');
      await keriClient.waitForMemberRotation(stewardAid, expectedStewardSn, { timeoutMs: 5 * 60_000 });

      // --- Step 2c: Round 2 — admin pre-rotates again, member becomes signer ---
      processingStep.value = 'Promoting steward to signer (round 2)...';
      onStep?.('Promoting steward to signer (round 2)...');
      await keriClient.addMemberRound2(orgName, stewardAid, personalAid.name, expectedStewardSn);
      console.log('[AdminActions] Steward added to org multisig');

      // --- Steps 3-4: Revoke the old credential + issue a new one with the
      // updated role, and update the profile. Shared with the non-steward
      // role-change path so profile role and credential role can never drift.
      const reissued = await reissueMembershipCredential(stewardAid, newRole, onStep);
      if (!reissued) throw new Error('Credential re-issue failed during steward upgrade');

      // Elevate the new steward's any-sync permission to Admin on both community
      // and community-readonly spaces. Writer alone is not enough: writing the
      // CommunityProfile needs Writer on readonly, but creating new community/
      // readonly invites for incoming members needs Admin (CanManageAccounts).
      // Without this, the steward's init-member call returns 500 and the
      // subsequent community/invite call returns "insufficient permissions".
      const grantResult = await grantStewardAdmin(stewardAid);
      if (!grantResult.success) {
        console.warn('[AdminActions] grantStewardAdmin failed:', grantResult.error);
      } else {
        console.log('[AdminActions] Granted Admin permission to new steward on community + readonly spaces');
      }

      onStep?.('Complete');
      console.log('[AdminActions] Steward upgrade complete');
      return true;
    } catch (err) {
      console.error('[AdminActions] Failed to upgrade steward:', err);
      return false;
    } finally {
      isProcessing.value = false;
      processingStep.value = '';
    }
  }

  /**
   * Adopt witnesses on the current org's group AID. Used to migrate orgs
   * created before the witness-fix landed (`toad: 0, wits: []`) into a
   * witness-backed shape so the multisig member-promotion flow can run.
   *
   * Idempotent: a no-op for orgs that already have witnesses.
   */
  async function runAdoptWitnesses(
    onStep?: (step: string) => void,
  ): Promise<'migrated' | 'already-migrated' | 'failed'> {
    const client = keriClient.getSignifyClient();
    if (!client) {
      console.error('[AdminActions] No SignifyClient for adopt-witnesses');
      return 'failed';
    }
    if (isProcessing.value) {
      console.warn('[AdminActions] Already processing — refusing concurrent adopt-witnesses');
      return 'failed';
    }
    isProcessing.value = true;
    processingStep.value = 'Adopting witnesses...';
    onStep?.('Adopting witnesses...');
    error.value = null;

    try {
      const orgAidPrefix = await getOrgAidName();
      const aids = await client.identifiers().list();
      const orgAid = aids.aids?.find((a: { prefix: string }) => a.prefix === orgAidPrefix);
      const orgName = orgAid?.name;
      if (!orgName) throw new Error('Could not find org AID name');

      const personalAid = aids.aids?.find((a: { prefix: string; name: string }) =>
        a.prefix !== orgAidPrefix && !a.name?.includes('org')
      );
      if (!personalAid) throw new Error('Could not find admin personal AID');

      const result = await keriClient.adoptOrgWitnesses(orgName, personalAid.name);
      onStep?.('Complete');
      console.log(`[AdminActions] adopt-witnesses result: ${result}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AdminActions] Adopt witnesses failed:', err);
      error.value = msg;
      return 'failed';
    } finally {
      isProcessing.value = false;
      processingStep.value = '';
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

      // 1. Resolve applicant identity (full fallback chain). The decline is
      // still recorded locally if this fails, but the failure must be
      // visible: an unreachable applicant will never receive the notice.
      const resolved = await resolveApplicant(registration, 60000);
      if (!resolved.ok) {
        notifyApprovalWarning(
          `Applicant could not be reached — the decline was recorded but they will not receive a notification (${resolved.detail}).`
        );
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

      // 4. Update SharedProfile status to declined.
      // createOrUpdateProfile is full-replace + validates required fields,
      // so we must read the existing profile and merge — sending only
      // { status: 'declined' } fails validation silently and the entry
      // keeps showing as pending.
      const profileId = `SharedProfile-${registration.applicantAid}`;
      try {
        const existing = await getProfileById('SharedProfile', profileId);
        if (!existing) {
          console.warn('[AdminActions] No existing SharedProfile to mark declined:', profileId);
        } else {
          const merged = { ...(existing.data || {}), status: 'declined' };
          const result = await createOrUpdateProfile('SharedProfile', merged, { id: profileId });
          if (result.success) {
            console.log('[AdminActions] Updated SharedProfile status to declined for:', registration.applicantAid);
          } else {
            console.warn('[AdminActions] Failed to update SharedProfile status to declined:', result.error);
          }
        }
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

      // 1. Resolve applicant identity (full fallback chain). A message has
      // no local fallback — if the applicant is unreachable, fail loudly
      // instead of pretending the message was sent.
      const resolved = await resolveApplicant(registration, 60000);
      if (!resolved.ok) {
        throw new Error(`Could not reach the applicant — message not sent (${resolved.detail}).`);
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

      // A member's profile can carry a "pending" placeholder (written during
      // approval, before the real SAID is issued/synced). Passing that to KERIA
      // revoke triggers GET /credentials/pending → 500, so treat any non-SAID
      // value as "unknown" and look the credential up by schema + subject AID.
      if (!isLikelyCredentialSaid(saidToRevoke)) {
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
          throw new Error(`No membership credential found for member ${memberAid}. Cannot remove without revoking credential.`);
        }
      }

      await keriClient.revokeCredential(orgAidPrefix, saidToRevoke);
      console.log('[AdminActions] Credential revoked:', saidToRevoke);

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
    processingStep,
    error,
    lastAction,

    // Actions
    approveRegistration,
    addStewardToOrgMultisig,
    upgradeMemberToSteward,
    reissueMembershipCredential,
    runAdoptWitnesses,
    declineRegistration,
    sendMessageToApplicant,
    removeMember,
    clearError,
  };
}
