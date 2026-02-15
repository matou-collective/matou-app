/**
 * Composable for the invitee claim flow.
 * Connects to a pre-created KERIA agent using the invite code (encoded mnemonic),
 * auto-admits IPEX credential grants, rotates AID keys for cryptographic ownership,
 * and persists the session. The recovery mnemonic is derived from the invite code.
 */
import { ref } from 'vue';
import { useKERIClient, KERIClient } from 'src/lib/keri/client';
import { useOnboardingStore } from 'stores/onboarding';
import { useAppStore } from 'stores/app';
import { setBackendIdentity, createOrUpdateProfile, uploadFile } from 'src/lib/api/client';
import { useIdentityStore } from 'stores/identity';
import { secureStorage } from 'src/lib/secureStorage';

// KERIA CESR URL as seen from inside Docker (used for OOBI resolution).
// OOBI resolution is server-side — KERIA resolves via its Docker network.
// This is a fixed internal Docker hostname, not configurable per environment.
const KERIA_DOCKER_URL = 'http://keria:3902';

export type ClaimStep = 'connecting' | 'admitting' | 'rotating' | 'securing' | 'done' | 'error';

export interface ValidateResult {
  name: string;
  prefix: string;
  passcode: string;
  mnemonic: string[];
}

/** Retry a profile creation call with backoff (space key derivation is async after join) */
async function retryProfile(
  fn: () => Promise<{ success: boolean; error?: string }>,
  maxAttempts = 5,
  baseDelay = 1500,
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    if (result.success) return result;
    if (attempt === maxAttempts) return result;
    console.log(`[ClaimIdentity] Profile creation attempt ${attempt}/${maxAttempts} failed, retrying...`);
    await new Promise(r => setTimeout(r, baseDelay * attempt));
  }
  return { success: false, error: 'max retries exceeded' };
}

export function useClaimIdentity() {
  const keriClient = useKERIClient();

  const step = ref<ClaimStep>('connecting');
  const error = ref<string | null>(null);
  const progress = ref('');

  /**
   * Validate an invite code: decode mnemonic, derive passcode, connect to KERIA,
   * and check the pre-created agent is valid and unclaimed.
   * @returns AID info, derived passcode, and mnemonic if valid; null otherwise
   */
  async function validate(inviteCode: string): Promise<ValidateResult | null> {
    try {
      console.log('[ClaimIdentity:validate] invite code length:', inviteCode?.length);

      // Decode invite code → mnemonic → passcode
      const mnemonic = KERIClient.mnemonicFromInviteCode(inviteCode);
      const passcode = KERIClient.passcodeFromMnemonic(mnemonic);

      await keriClient.initialize(passcode);
      const aids = await keriClient.listAIDs();
      console.log('[ClaimIdentity:validate] connected OK, AIDs:', aids.length);
      if (aids.length === 0) return null;

      // Check if already claimed: AID key rotation (s > 0) means claimed.
      // Use identifiers().get() for the full HabState with reliable key state.
      const aid = aids[0];
      const client = keriClient.getSignifyClient();
      if (client) {
        const habState = await client.identifiers().get(aid.prefix);
        const sn = parseInt(String(habState?.state?.s ?? '0'), 16);
        console.log('[ClaimIdentity:validate] AID key state s =', sn, 'raw =', habState?.state?.s);
        if (sn > 0) {
          console.log('[ClaimIdentity:validate] AID already claimed');
          return null;
        }
      }

      return {
        name: aid.name,
        prefix: aid.prefix,
        passcode,
        mnemonic: mnemonic.split(' '),
      };
    } catch (err) {
      console.error('[ClaimIdentity:validate] FAILED:', err);
      return null;
    }
  }

  /**
   * Run the full claim flow: connect, admit grants, rotate AID keys,
   * and persist session. The recovery mnemonic was already derived during
   * validate() and stored in the onboarding store.
   * Assumes validate() has already been called and the client is connected.
   */
  async function claimIdentity(passcode: string): Promise<boolean> {
    error.value = null;

    try {
      // Step 1: Connect to pre-created agent
      step.value = 'connecting';
      progress.value = 'Connecting to your pre-created identity...';

      // Always re-initialize: component transitions can cause the SignifyClient
      // connection to become stale. initialize() connects to the existing agent.
      await keriClient.initialize(passcode);

      const aids = await keriClient.listAIDs();
      if (aids.length === 0) {
        throw new Error('No identity found in agent — invalid claim link');
      }
      let aid = aids[0];
      console.log('[ClaimIdentity] Connected, found AID:', aid.prefix);

      const client = keriClient.getSignifyClient();
      if (!client) throw new Error('SignifyClient not available');

      // Rename AID to user's chosen display name (slugified for KERIA compatibility)
      const onboardingStore = useOnboardingStore();
      const profileName = onboardingStore.profile.name?.trim();
      if (profileName) {
        const aidName = profileName.toLowerCase().replace(/\s+/g, '-');
        if (aidName !== aid.name) {
          progress.value = 'Updating identity name...';
          const updated = await client.identifiers().update(aid.prefix, { name: aidName });
          console.log(`[ClaimIdentity] Renamed AID from "${aid.name}" to "${updated.name}"`);
          aid = updated;
        }
      }

      // Step 2: Auto-admit pending IPEX grants
      step.value = 'admitting';
      progress.value = 'Accepting credential grants...';

      const notifications = await client.notifications().list();
      const grants = (notifications.notes || []).filter(
        (n: { a: { r: string }; r: boolean }) => n.a?.r === '/exn/ipex/grant' && !n.r
      );

      console.log(`[ClaimIdentity] Found ${grants.length} pending grant(s)`);

      // Capture space invite data from grant messages
      let spaceInvite: {
        inviteKey: string;
        spaceId?: string;
        readOnlyInviteKey?: string;
        readOnlySpaceId?: string;
      } | null = null;

      // Pre-resolve grant senders' key state via KERIA OOBI.
      // The grant may be escrowed on the invitee's KERIA agent because the
      // sender's AID was not in kevers when the grant arrived (the OOBI
      // resolution during invite creation can race with the grant delivery).
      // Using a bare OOBI (/oobi/{prefix}) causes KERIA to serve the full
      // key event log for the sender, populating kevers and triggering
      // de-escrowing of the grant.
      const resolvedSenders = new Set<string>();
      for (const grant of grants) {
        try {
          const grantExn = await client.exchanges().get(grant.a.d);
          const senderPrefix = grantExn.exn.i;
          if (senderPrefix && !resolvedSenders.has(senderPrefix)) {
            resolvedSenders.add(senderPrefix);
            const senderOobi = `${KERIA_DOCKER_URL}/oobi/${senderPrefix}`;
            console.log(`[ClaimIdentity] Resolving grant sender OOBI: ${senderOobi}`);
            progress.value = 'Resolving credential issuer identity...';
            const resolveOp = await client.oobis().resolve(senderOobi, `grant-sender-${senderPrefix}`);
            await client.operations().wait(resolveOp, { signal: AbortSignal.timeout(30000) });
            console.log(`[ClaimIdentity] Sender ${senderPrefix} OOBI resolved`);
          }
        } catch (oobiErr) {
          console.warn('[ClaimIdentity] Sender OOBI resolution failed:', oobiErr);
        }
      }

      // Allow KERIA's escrow processor to de-escrow the grant now that the
      // sender's key state is in kevers. The escrow loop runs on a tick;
      // 10 seconds gives the processor several cycles to de-escrow.
      if (resolvedSenders.size > 0) {
        console.log('[ClaimIdentity] Waiting for escrow processing...');
        await new Promise(r => setTimeout(r, 10000));
      }

      for (const grant of grants) {
        try {
          const grantExn = await client.exchanges().get(grant.a.d);
          const grantSender = grantExn.exn.i;

          // Extract space invite from grant message
          const msg = grantExn.exn.a?.m || (grant.a as Record<string, unknown>)?.m;
          if (msg && !spaceInvite) {
            try {
              const parsed = JSON.parse(String(msg));
              if (parsed.type === 'space_invite' && parsed.inviteKey) {
                spaceInvite = parsed;
                console.log('[ClaimIdentity] Space invite found in grant message');
              }
            } catch { /* not JSON */ }
          }

          // Submit admit with empty embeds. KERIA's sendAdmit() for single-sig
          // AIDs does not process path labels — the Admitter background task
          // retrieves ACDC/ISS/ANC data from the GRANT's cloned attachments.
          // Including embeds here would cause psr.parseOne() to fail looking
          // for path-labeled CESR attachments that aren't present.
          const hab = await client.identifiers().get(aid.prefix);
          const [admit, sigs, atc] = await client.exchanges().createExchangeMessage(
            hab,
            '/ipex/admit',
            { m: '' },
            {},
            grantSender,
            undefined,
            grant.a.d,
          );
          await client.ipex().submitAdmit(aid.prefix, admit, sigs, atc, [grantSender]);
          await client.notifications().mark(grant.i);
          console.log(`[ClaimIdentity] Admitted grant ${grant.a.d}`);
        } catch (admitErr) {
          console.warn(`[ClaimIdentity] Failed to admit grant ${grant.a.d}:`, admitErr);
          // Continue — some grants may have already been admitted
        }
      }

      // Wait for credentials to appear in wallet (IPEX admit is async —
      // KERIA processes the admit in the background after submitAdmit returns)
      if (grants.length > 0) {
        progress.value = 'Waiting for credentials to be processed...';
        let credentials: any[] = [];
        for (let attempt = 1; attempt <= 15; attempt++) {
          credentials = await client.credentials().list();
          console.log(`[ClaimIdentity] Credential poll attempt ${attempt}: ${credentials.length} credentials`);
          if (credentials.length > 0) break;
          await new Promise(r => setTimeout(r, 2000));
        }
        if (credentials.length === 0) {
          throw new Error('No credentials appeared in wallet after IPEX admit — credential grant was not processed');
        }
        for (const cred of credentials) {
          console.log(`[ClaimIdentity] Credential SAID: ${cred.sad?.d}, schema: ${cred.sad?.s}, status: ${cred.status?.s}`);
        }
      }

      // Step 3: Rotate AID keys (take cryptographic ownership)
      // The agent passcode is NOT rotated — the invite code encodes the mnemonic
      // that derives the boot passcode, so recovery can reconnect to the same agent.
      // AID key rotation provides cryptographic ownership and marks the invite as claimed.
      step.value = 'rotating';
      progress.value = 'Rotating keys to take ownership...';

      await keriClient.rotateKeys(aid.prefix);
      console.log('[ClaimIdentity] AID keys rotated');

      // Persist session (same passcode — no agent rotation)
      await secureStorage.setItem('matou_passcode', passcode);

      // Step 4: Set up account (backend identity, space join, profiles)
      step.value = 'securing';
      progress.value = 'Configuring backend identity...';

      const onboardingMnemonic = useOnboardingStore().mnemonic.words;
      if (onboardingMnemonic.length === 0) {
        throw new Error('No mnemonic available for backend identity setup');
      }
      const mnemonicStr = onboardingMnemonic.join(' ');
      await secureStorage.setItem('matou_mnemonic', mnemonicStr);

      const appStore = useAppStore();
      const identityResult = await setBackendIdentity({
        aid: aid.prefix,
        mnemonic: mnemonicStr,
        orgAid: appStore.orgAid ?? undefined,
        communitySpaceId: appStore.orgConfig?.communitySpaceId ?? undefined,
        readOnlySpaceId: appStore.orgConfig?.readOnlySpaceId ?? undefined,
        mode: 'claim',
      });
      if (!identityResult.success) {
        throw new Error(`Backend identity setup failed: ${identityResult.error || 'unknown error'}`);
      }
      console.log('[ClaimIdentity] Backend identity set, peer:', identityResult.peerId,
        'private space:', identityResult.privateSpaceId);

      // Populate identity store so router guard allows /dashboard access
      const identityStore = useIdentityStore();
      identityStore.setCurrentAID({ name: aid.name, prefix: aid.prefix, state: aid.state ?? null });

      // Join community + readonly spaces (required — fail if missing or unsuccessful)
      progress.value = 'Joining community space...';
      if (!spaceInvite) {
        throw new Error('No community space invite found in credential grant');
      }
      const joined = await identityStore.joinCommunitySpace({
        inviteKey: spaceInvite.inviteKey,
        spaceId: spaceInvite.spaceId,
        readOnlyInviteKey: spaceInvite.readOnlyInviteKey,
        readOnlySpaceId: spaceInvite.readOnlySpaceId,
      });
      if (!joined) {
        throw new Error('Failed to join community and readonly spaces');
      }
      console.log('[ClaimIdentity] Joined community space');

      // Upload avatar if we have base64 data but no fileRef
      // (the original upload during onboarding failed because community space didn't exist)
      if (!onboardingStore.profile.avatarFileRef && onboardingStore.profile.avatarData) {
        try {
          progress.value = 'Uploading avatar...';
          const base64Data = onboardingStore.profile.avatarData;
          const mimeType = onboardingStore.profile.avatarMimeType || 'image/png';
          // Convert base64 to File for uploadFile()
          const byteChars = atob(base64Data);
          const byteArray = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) {
            byteArray[i] = byteChars.charCodeAt(i);
          }
          const blob = new Blob([byteArray], { type: mimeType });
          const avatarFile = new File([blob], 'avatar', { type: mimeType });
          const uploadResult = await uploadFile(avatarFile);
          if (uploadResult.fileRef) {
            onboardingStore.updateProfile({ avatarFileRef: uploadResult.fileRef });
            console.log('[ClaimIdentity] Avatar uploaded after space join, fileRef:', uploadResult.fileRef);
          }
        } catch (avatarErr) {
          console.warn('[ClaimIdentity] Avatar upload after space join failed:', avatarErr);
        }
      }

      // Populate identity info for the dashboard
      onboardingStore.setUserAID(aid.prefix);
      if (!onboardingStore.profile.name) {
        onboardingStore.updateProfile({ name: aid.name });
      }

      // Create profiles (required — retry with backoff since space key derivation is async)
      progress.value = 'Creating profiles...';
      const displayName = onboardingStore.profile.name || aid.name;
      const now = new Date().toISOString();

      const creds = await client.credentials().list();
      const credSAID = creds.length > 0 ? (creds[0].sad?.d || '') : '';

      // PrivateProfile in personal space
      const privateResult = await retryProfile(() =>
        createOrUpdateProfile('PrivateProfile', {
          membershipCredentialSAID: credSAID,
          privacySettings: { allowEndorsements: true, allowDirectMessages: true },
          appPreferences: { mode: 'light', language: 'es' },
        }),
      );
      if (!privateResult.success) {
        throw new Error(`PrivateProfile creation failed: ${privateResult.error || 'unknown'}`);
      }

      // SharedProfile in community space (required — community space keys are
      // now persisted during join, so this should succeed after retries)
      const sharedResult = await retryProfile(() =>
        createOrUpdateProfile('SharedProfile', {
          aid: aid.prefix,
          displayName,
          bio: onboardingStore.profile.bio || '',
          avatar: onboardingStore.profile.avatarFileRef || '',
          publicEmail: onboardingStore.profile.email || '',
          location: onboardingStore.profile.location || '',
          indigenousCommunity: onboardingStore.profile.indigenousCommunity || '',
          joinReason: onboardingStore.profile.joinReason || '',
          facebookUrl: onboardingStore.profile.facebookUrl || '',
          linkedinUrl: onboardingStore.profile.linkedinUrl || '',
          twitterUrl: onboardingStore.profile.twitterUrl || '',
          instagramUrl: onboardingStore.profile.instagramUrl || '',
          participationInterests: onboardingStore.profile.participationInterests || [],
          customInterests: onboardingStore.profile.customInterests || '',
          lastActiveAt: now,
          createdAt: now,
          updatedAt: now,
          typeVersion: 1,
        }),
      );
      if (!sharedResult.success) {
        throw new Error(`SharedProfile creation failed: ${sharedResult.error || 'unknown'}`);
      }

      console.log('[ClaimIdentity] Profiles created');

      // Done
      step.value = 'done';
      progress.value = 'Identity claimed successfully!';
      console.log('[ClaimIdentity] Claim complete');

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to claim identity';
      console.error('[ClaimIdentity] Error:', err);
      error.value = errorMsg;
      step.value = 'error';
      progress.value = '';
      return false;
    }
  }

  function reset() {
    step.value = 'connecting';
    error.value = null;
    progress.value = '';
  }

  return {
    step,
    error,
    progress,
    validate,
    claimIdentity,
    reset,
  };
}
