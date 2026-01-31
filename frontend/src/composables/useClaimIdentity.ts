/**
 * Composable for the invitee claim flow.
 * Connects to a pre-created KERIA agent using the invite code (encoded mnemonic),
 * auto-admits IPEX credential grants, rotates AID keys for cryptographic ownership,
 * and persists the session. The recovery mnemonic is derived from the invite code.
 */
import { ref } from 'vue';
import { useKERIClient, KERIClient } from 'src/lib/keri/client';
import { useOnboardingStore } from 'stores/onboarding';

export type ClaimStep = 'connecting' | 'admitting' | 'rotating' | 'securing' | 'done' | 'error';

export interface ValidateResult {
  name: string;
  prefix: string;
  passcode: string;
  mnemonic: string[];
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
        const habState = await client.identifiers().get(aid.name);
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
          const updated = await client.identifiers().update(aid.name, { name: aidName });
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

      for (const grant of grants) {
        try {
          const grantExn = await client.exchanges().get(grant.a.d);
          const grantSender = grantExn.exn.i;

          const [admit, sigs, atc] = await client.ipex().admit({
            senderName: aid.name,
            recipient: grantSender,
            grantSaid: grant.a.d,
          });
          await client.ipex().submitAdmit(aid.name, admit, sigs, atc, [grantSender]);
          await client.notifications().mark(grant.i);
          console.log(`[ClaimIdentity] Admitted grant ${grant.a.d}`);
        } catch (admitErr) {
          console.warn(`[ClaimIdentity] Failed to admit grant ${grant.a.d}:`, admitErr);
          // Continue — some grants may have already been admitted
        }
      }

      // Verify credentials in wallet
      const credentials = await client.credentials().list();
      console.log(`[ClaimIdentity] Credentials in wallet: ${credentials.length}`);

      // Step 3: Rotate AID keys (take cryptographic ownership)
      // The agent passcode is NOT rotated — the invite code encodes the mnemonic
      // that derives the boot passcode, so recovery can reconnect to the same agent.
      // AID key rotation provides cryptographic ownership and marks the invite as claimed.
      step.value = 'rotating';
      progress.value = 'Rotating keys to take ownership...';

      await keriClient.rotateKeys(aid.name);
      console.log('[ClaimIdentity] AID keys rotated');

      // Persist session (same passcode — no agent rotation)
      localStorage.setItem('matou_passcode', passcode);

      // Populate identity info for the dashboard
      onboardingStore.setUserAID(aid.prefix);
      if (!onboardingStore.profile.name) {
        onboardingStore.updateProfile({ name: aid.name });
      }

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
