/**
 * Composable for the invitee claim flow.
 * Connects to a pre-created KERIA agent using the passcode from the claim link,
 * auto-admits IPEX credential grants, generates a permanent mnemonic,
 * rotates AID keys and agent passcode for cryptographic ownership.
 */
import { ref } from 'vue';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { KERIClient, useKERIClient } from 'src/lib/keri/client';
import { useOnboardingStore } from 'stores/onboarding';

export type ClaimStep = 'connecting' | 'admitting' | 'generating' | 'rotating' | 'done' | 'error';

export function useClaimIdentity() {
  const keriClient = useKERIClient();

  const step = ref<ClaimStep>('connecting');
  const error = ref<string | null>(null);
  const mnemonic = ref<string[]>([]);
  const progress = ref('');

  /**
   * Validate that the passcode connects to a valid pre-created agent
   * @returns AID name and prefix if valid, null otherwise
   */
  async function validate(passcode: string): Promise<{ name: string; prefix: string } | null> {
    try {
      await keriClient.initialize(passcode);
      const aids = await keriClient.listAIDs();
      if (aids.length === 0) return null;
      return { name: aids[0].name, prefix: aids[0].prefix };
    } catch {
      return null;
    }
  }

  /**
   * Run the full claim flow: connect, admit grants, generate mnemonic, rotate keys + passcode.
   * Assumes validate() has already been called and the client is connected.
   */
  async function claimIdentity(passcode: string): Promise<boolean> {
    error.value = null;
    mnemonic.value = [];

    try {
      // Step 1: Connect to pre-created agent
      step.value = 'connecting';
      progress.value = 'Connecting to your pre-created identity...';

      // Initialize if not already connected (validate may have done this)
      if (!keriClient.isConnected()) {
        await keriClient.initialize(passcode);
      }

      const aids = await keriClient.listAIDs();
      if (aids.length === 0) {
        throw new Error('No identity found in agent — invalid claim link');
      }
      const aid = aids[0];
      console.log('[ClaimIdentity] Connected, found AID:', aid.prefix);

      // Step 2: Auto-admit pending IPEX grants
      step.value = 'admitting';
      progress.value = 'Accepting credential grants...';

      const client = keriClient.getSignifyClient();
      if (!client) throw new Error('SignifyClient not available');

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

      // Step 3: Generate permanent mnemonic
      step.value = 'generating';
      progress.value = 'Generating your personal recovery phrase...';

      const permanentMnemonic = generateMnemonic(wordlist, 128);
      mnemonic.value = permanentMnemonic.split(' ');
      const newPasscode = KERIClient.passcodeFromMnemonic(permanentMnemonic);
      console.log('[ClaimIdentity] Permanent mnemonic generated');

      // Step 4: Rotate AID keys (take cryptographic ownership)
      step.value = 'rotating';
      progress.value = 'Rotating keys to take ownership...';

      await keriClient.rotateKeys(aid.name);
      console.log('[ClaimIdentity] AID keys rotated');

      // Step 5: Rotate agent passcode
      progress.value = 'Securing your agent with new passcode...';
      await keriClient.rotateAgentPasscode(newPasscode, [aid.prefix]);
      console.log('[ClaimIdentity] Agent passcode rotated');

      // Step 6: Persist new session
      localStorage.setItem('matou_passcode', newPasscode);

      // Step 7: Populate onboarding store for mnemonic screens
      const onboardingStore = useOnboardingStore();
      onboardingStore.setMnemonic(mnemonic.value);
      onboardingStore.setUserAID(aid.prefix);
      onboardingStore.updateProfile({ name: aid.name });

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
    mnemonic.value = [];
    progress.value = '';
  }

  return {
    step,
    error,
    mnemonic,
    progress,
    validate,
    claimIdentity,
    reset,
  };
}
