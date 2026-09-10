/**
 * useRecoverIdentity — the identity-recovery sequence lifted out of
 * `RecoveryScreen.vue` (validate mnemonic → derive passcode → connect to the
 * existing KERIA agent → persist the local hints) so it can be shared by
 * RecoveryScreen and the linked-device screens (spec
 * `docs/superpowers/specs/2026-09-08-linked-device-sign-in-design.md` §1
 * "After receipt").
 *
 * `identityStore.connect` already persists `matou_passcode`; this composable
 * additionally stores `matou_mnemonic` (needed by WelcomeOverlayScreen's
 * backend `identity/set`) and, on the link path, the `matou_admin_aid` hint
 * that travels with the identity (§3.4). The caller then routes to
 * `welcome-overlay`, which drives the backend setup and membership checks.
 */
import { useIdentityStore } from 'stores/identity';
import { KERIClient } from 'src/lib/keri/client';
import { secureStorage } from 'src/lib/secureStorage';

export interface RecoverResult {
  aid: string;
  name: string;
}

export interface RecoverOptions {
  /** The steward's admin AID from the pairing `identity` message (§3.4). */
  adminAid?: string;
}

export function useRecoverIdentity() {
  const identityStore = useIdentityStore();

  /**
   * Recover the identity for `mnemonic` (a 12-word string, or the array of
   * words from the recovery form). Resolves with the recovered AID + name, or
   * throws with a user-facing message on any failure.
   */
  async function recover(
    mnemonic: string | string[],
    options: RecoverOptions = {},
  ): Promise<RecoverResult> {
    const phrase = (Array.isArray(mnemonic) ? mnemonic.join(' ') : mnemonic)
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .join(' ');

    if (!KERIClient.validateMnemonic(phrase)) {
      throw new Error('Invalid recovery phrase. Please check your words and try again.');
    }

    const passcode = KERIClient.passcodeFromMnemonic(phrase);

    const connected = await identityStore.connect(passcode);
    if (!connected) {
      throw new Error(
        identityStore.error || 'Failed to connect. This phrase may not have an identity yet.',
      );
    }

    if (!identityStore.hasIdentity || !identityStore.currentAID) {
      throw new Error('No identity found for this recovery phrase. It may be a new phrase.');
    }

    // Persist the hints the downstream backend setup / AID pick need. connect()
    // already wrote matou_passcode.
    await secureStorage.setItem('matou_mnemonic', phrase);
    if (options.adminAid) {
      await secureStorage.setItem('matou_admin_aid', options.adminAid);
    }

    return {
      aid: identityStore.currentAID.prefix,
      name: identityStore.currentAID.name,
    };
  }

  return { recover };
}
