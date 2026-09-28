/**
 * useUnlock — the unlock-only card's controller (idss #1929 story 14–16,
 * wireframe PU-A4; ADR 0282 d.3; matou-app #664).
 *
 * A control panel that is signed in but LOCKED (a reload, a tab close, an
 * explicit Lock, or the unlock line switched off at sign-in) shows an *unlock
 * code*, not a sign-in code. Scanning it lands here. This card carries the unlock
 * and ONLY the unlock: it presents no credential, mints no session, and signs no
 * challenge — the panel is already signed in, so a reload must never look like
 * being signed out. On **Unlock** the wallet seals the steward's passcode to the
 * FRESH key the code carried and posts it once. *Not now* seals and posts
 * nothing, and changes nothing about the steward's session.
 *
 * Its dependencies are injected (defaults wired to the real stores and crypto) so
 * the phase machine and view model are unit-testable without signify-ts or a live
 * door — the same seam useSignin uses.
 */

import { ref, shallowRef } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'src/stores/identity';
import { parseUnlockLink, type UnlockAsk } from 'src/lib/signin/link';
import { fingerprintOf, sealPasscode } from 'src/lib/signin/sealedPasscode';
import { buildUnlockView, type UnlockCardView } from 'src/lib/signin/view';
import { postUnlock, type UnlockBody } from 'src/lib/signin/unlock';
import type { PresentVerdict } from 'src/lib/signin/present';
import { refusalCopy, type RefusalCopy } from 'src/lib/signin/refusal';
import { walletReady } from 'src/composables/useSignin';

/**
 * The unlock card's faces. `loading` holds until the wallet is ready and the card
 * is built; `unavailable` is the try-again fallback when it could not be;
 * `expired` is the clean refusal for a code whose challenge already died at read
 * time (no Unlock button, nothing sealed). `card` shows the unlock-only face,
 * `unlocking` is the in-flight post, `done` is the unlocked panel, and `refused`
 * carries a door refusal or an unreachable relay.
 */
export type UnlockPhase = 'loading' | 'unavailable' | 'expired' | 'card' | 'unlocking' | 'done' | 'refused';

/** Injectable side-effects; production defaults resolve the real stores/crypto. */
export interface UnlockDeps {
  /** The short fingerprint of the tab's fresh sealing-key verkey, for details. */
  sealingKeyFingerprint(verkey: string): Promise<string>;
  /**
   * Seal the steward's held passcode to the tab's fresh sealing-key verkey,
   * returning the CESR qb64 cipher, or null when there is no passcode to seal.
   * The passcode is read inside this call and never leaves it.
   */
  sealPasscode(verkey: string): Promise<string | null>;
  /** POST the sealed passcode to the relay URL and read the door's verdict. */
  post(relayUrl: string, body: UnlockBody): Promise<PresentVerdict>;
  /** Resolve once the wallet can answer (its session restored). */
  ready(): Promise<void>;
  /** The current wall-clock instant, injectable so the expiry check is testable. */
  now(): number;
}

function defaultDeps(): UnlockDeps {
  const keri = useKERIClient();
  const identity = useIdentityStore();
  return {
    ready: () => walletReady(identity, keri),
    sealingKeyFingerprint: (verkey) => fingerprintOf(verkey),
    async sealPasscode(verkey: string) {
      // The passcode lives in the unlocked identity store; read it here, seal it,
      // and let only the ciphertext leave. No passcode is returned or logged.
      const bran = identity.passcode;
      if (!bran) return null;
      return sealPasscode(bran, verkey);
    },
    post: postUnlock,
    now: () => Date.now(),
  };
}

export function useUnlock(deps: UnlockDeps = defaultDeps()) {
  const identity = useIdentityStore();

  const ask = shallowRef<UnlockAsk | null>(null);
  const view = shallowRef<UnlockCardView | null>(null);
  const phase = ref<UnlockPhase>('loading');
  const refusal = ref<RefusalCopy | null>(null);

  /**
   * Parse a `matou://unlock` link and prepare the card, or return false when the
   * text is not an unlock link.
   */
  async function prepareFromLink(text: string): Promise<boolean> {
    const parsed = parseUnlockLink(text);
    if (!parsed) return false;
    await prepare(parsed);
    return true;
  }

  /**
   * Prepare the unlock-only card from an already-parsed ask. Holds on `loading`
   * until the wallet is ready; a code whose challenge has already expired lands
   * on `expired` (a clean refusal, no Unlock) rather than sealing to a dead
   * challenge; any other failure lands on `unavailable`.
   */
  async function prepare(parsed: UnlockAsk): Promise<void> {
    ask.value = parsed;
    phase.value = 'loading';
    refusal.value = null;
    view.value = null;

    // A code that already died refuses cleanly at read time — nothing is sealed
    // and no relay is touched (the door's 410 is a second guard on Unlock).
    if (parsed.expiresAt !== null && parsed.expiresAt <= deps.now()) {
      phase.value = 'expired';
      return;
    }

    try {
      await deps.ready();
      const aid = identity.aidPrefix ?? '';
      const fingerprint = await deps.sealingKeyFingerprint(parsed.sealingKey);
      view.value = buildUnlockView(
        parsed.panel,
        parsed.community,
        parsed.challenge,
        aid,
        parsed.signedInAt,
        fingerprint,
      );
    } catch (err) {
      console.warn('[Unlock] Could not prepare the unlock:', err);
      phase.value = 'unavailable';
      return;
    }

    phase.value = 'card';
  }

  /** Try again from the `unavailable` face: prepare the same unlock afresh. */
  async function retry(): Promise<void> {
    if (ask.value) await prepare(ask.value);
  }

  /**
   * Unlock: seal the steward's passcode to the code's FRESH key and post it once
   * (story 15). Nothing is presented and no session is minted. A seal that yields
   * no cipher (no passcode to seal) is a wallet-side failure shown as the
   * wallet-only unreachable line — nothing reaches the door.
   */
  async function unlock(): Promise<void> {
    const a = ask.value;
    if (!a) return;

    phase.value = 'unlocking';
    refusal.value = null;

    let sealed: string | null;
    try {
      sealed = await deps.sealPasscode(a.sealingKey);
    } catch {
      console.warn('[Unlock] Could not seal the passcode');
      sealed = null;
    }
    if (!sealed) {
      refusal.value = refusalCopy('site-unreachable');
      phase.value = 'refused';
      return;
    }

    let verdict: PresentVerdict;
    try {
      verdict = await deps.post(a.present, { challenge_id: a.challenge, sealed_passcode: sealed });
    } catch {
      verdict = { outcome: 'site-unreachable' };
    }

    if (verdict.outcome === 'verified') {
      phase.value = 'done';
      return;
    }
    refusal.value = refusalCopy(verdict.outcome === 'refused' ? verdict.refusal : 'site-unreachable');
    phase.value = 'refused';
  }

  /** Not now: nothing was sealed or posted, and nothing about the steward's
   *  session changes (story 16). The caller closes the card. */
  function notNow(): void {
    refusal.value = null;
  }

  /** Try again after a refusal: back to the card (the panel shows a fresh code
   *  for a genuinely dead one, so this only re-offers Unlock for this ask). */
  function tryAgain(): void {
    if (phase.value === 'expired') return;
    phase.value = 'card';
    refusal.value = null;
  }

  return {
    ask,
    view,
    phase,
    refusal,
    prepareFromLink,
    prepare,
    retry,
    unlock,
    notNow,
    tryAgain,
  };
}
