/**
 * useRecoverIdentity — the identity-recovery sequence lifted out of
 * RecoveryScreen.vue so the "Recover identity" flow and both linked-device
 * sign-in screens (#466: desktop QR #472, mobile scan #473) run exactly the
 * same steps: validate the 12-word phrase → derive the KERI passcode → connect
 * to the (existing) KERIA agent → confirm an identity was found → persist
 * `matou_mnemonic` for the backend identity setup that the welcome overlay
 * performs later.
 *
 * `mode: 'link'` adds the split-identity safeguards from the spec (§3.4): the
 * `identity` message a holder sends carries the AID hints, and this composable
 * stores `matou_admin_aid` / `matou_org_aid` **before** connect, because
 * `identityStore.connect` reads `matou_admin_aid` to pick the current AID — on
 * a fresh device without the hint the pick falls back to "first non-org AID",
 * which is wrong for a steward whose agent also holds the group AID. The later
 * `POST /api/v1/identity/set` then goes out with `mode: "link"` (driven off the
 * onboarding path in WelcomeOverlayScreen), which makes the backend wait for the
 * private space to sync instead of creating a fork (§3.2).
 */

import { useIdentityStore } from 'stores/identity';
import { KERIClient } from 'src/lib/keri/client';
import { secureStorage } from 'src/lib/secureStorage';

export type RecoverMode = 'recover' | 'link';

export interface RecoverIdentityOptions {
  /** 'recover' (default) or 'link' — link stores the AID hints before connect. */
  mode?: RecoverMode;
  /** Admin/steward AID hint from the holder's `identity` message (link mode). */
  adminAid?: string;
  /** Org (group) AID hint from the holder's `identity` message (link mode). */
  orgAid?: string;
}

export interface RecoverIdentityResult {
  success: boolean;
  /** Recovered AID prefix, on success. */
  aid?: string;
  /** Recovered AID display name, on success. */
  name?: string;
  /** Human-readable failure reason, on failure. */
  error?: string;
}

/** Normalise a phrase (or the recovery form's word array) to lower-case,
 * single-spaced words. */
function normalizeMnemonic(input: string | string[]): string {
  const text = Array.isArray(input) ? input.join(' ') : input;
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export function useRecoverIdentity() {
  const identityStore = useIdentityStore();

  async function recoverIdentity(
    mnemonicInput: string | string[],
    options: RecoverIdentityOptions = {},
  ): Promise<RecoverIdentityResult> {
    const mode = options.mode ?? 'recover';
    const mnemonic = normalizeMnemonic(mnemonicInput);

    // Step 1: Validate mnemonic
    if (!KERIClient.validateMnemonic(mnemonic)) {
      return {
        success: false,
        error: 'Invalid recovery phrase. Please check your words and try again.',
      };
    }

    // Link mode: persist the AID hints before connect (spec §3.4).
    if (mode === 'link') {
      if (options.adminAid) await secureStorage.setItem('matou_admin_aid', options.adminAid);
      if (options.orgAid) await secureStorage.setItem('matou_org_aid', options.orgAid);
    }

    // Step 2: Derive passcode from mnemonic
    const passcode = KERIClient.passcodeFromMnemonic(mnemonic);

    // Step 3: Connect to the (existing) KERIA agent
    const connected = await identityStore.connect(passcode);
    if (!connected) {
      return {
        success: false,
        error:
          identityStore.error ||
          'Failed to connect. This phrase may not have an identity yet.',
      };
    }

    // Step 4: Confirm an identity was found
    if (identityStore.hasIdentity && identityStore.currentAID) {
      await secureStorage.setItem('matou_mnemonic', mnemonic);
      return {
        success: true,
        aid: identityStore.currentAID.prefix,
        name: identityStore.currentAID.name,
      };
    }

    return {
      success: false,
      error: 'No identity found for this recovery phrase. It may be a new phrase.',
    };
  }

  return { recoverIdentity };
}
