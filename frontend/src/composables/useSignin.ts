/**
 * useSignin — the approve card's controller (idss spec #1492 stories 10, 13–18,
 * 28; wireframe WS-A2/A2p/A2d/A2r; ADR 0236).
 *
 * Given a parsed sign-in ask it resolves the credential to present, builds the
 * card view model, and drives the four faces: the card (WS-A2), Proving
 * (WS-A2p), Signed in (WS-A2d) and the refusal region (WS-A2r). Approve does the
 * whole thing in one tap — sign the door-bound message, export the credential,
 * post, read the verdict — reusing the in-memory signer on a repeat sign-in.
 * Not now signs and posts nothing.
 *
 * The KERI-side dependencies are injected (defaults wired to the real client
 * and stores) so the phase machine and view model are unit-testable without
 * signify-ts or a live door.
 */

import { ref, shallowRef, watch } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { getCommunityDescriptor } from 'src/lib/clientConfig';
import { useIdentityStore } from 'src/stores/identity';
import { useKnownDoorsStore } from 'src/stores/knownDoors';
import { parseSigninLink, isPanelSignin, type SigninAsk } from 'src/lib/signin/link';
import { chooseCredential, describeCredential, type HeldCredential } from 'src/lib/signin/credential';
import { STEWARD_ROLE } from 'src/lib/spaces/steward';
import { fingerprintOf, sealPasscode } from 'src/lib/signin/sealedPasscode';
import { armForChallenge, type PasscodeSealer } from 'src/lib/signin/armedPasscode';
import { buildCardView, type ApproveCardView } from 'src/lib/signin/view';
import { runApprove } from 'src/lib/signin/approve';
import { getSigner } from 'src/lib/signin/signer';
import { presentToDoor, type PresentBody, type PresentVerdict } from 'src/lib/signin/present';
import { refusalCopy, type RefusalCopy } from 'src/lib/signin/refusal';

/**
 * The card's faces. `loading` holds until the wallet is ready and the card is
 * built; `unavailable` is the try-again fallback when it could not be.
 * `first-contact` (WS-A1) comes *before* the card when the ask names a sign-in
 * site the wallet has never met (#535); the rest are the approve card and its
 * follow-ons (WS-A2/A2p/A2d/A2r).
 */
export type SigninPhase = 'loading' | 'unavailable' | 'first-contact' | 'card' | 'proving' | 'done' | 'refused';

/** How long a sign-in waits for the wallet's session restore before giving up. */
const READY_TIMEOUT_MS = 45_000;

/**
 * How long an arming stays live after Approve, waiting for the panel to ask
 * (#674). A generous wallet-side upper bound on the OIDC hop + panel load; the
 * door's own challenge expiry is the real limit, this is the self-destruct so an
 * arming never lingers past a sign-in the panel never came back for.
 */
const ARMING_TTL_MS = 5 * 60_000;

/** Injectable side-effects; production defaults resolve the real client/stores. */
export interface SigninDeps {
  /** All credentials the wallet holds. */
  listCredentials(): Promise<HeldCredential[]>;
  /** Export a credential's full `includeCESR` stream by SAID. */
  exportCredential(said: string): Promise<string>;
  /** Sign a bound message with the member's cached signer. */
  sign(aid: string, message: string): Promise<string>;
  /** POST the presentation to a URL and read the verdict. */
  present(presentUrl: string, body: PresentBody): Promise<PresentVerdict>;
  /** schema SAID → descriptor kind key (e.g. "membership"), for the label. */
  schemaKinds(): Promise<Record<string, string>>;
  /**
   * The short fingerprint of the control-panel tab's sealing-key verkey, for the
   * details disclosure (#663). Only called for a control-panel sign-in.
   */
  sealingKeyFingerprint(verkey: string): Promise<string>;
  /**
   * Arm the wallet to seal the steward's passcode when the panel later asks, for
   * the challenge that lives until `expiresAt` (wall-clock ms). Called ONLY on a
   * control-panel unlock with the line on; it seals nothing now — the box the
   * panel can open is minted only when the panel asks, to the verkey it holds
   * (#674). The passcode never leaves this wallet's unlocked session (#663).
   */
  arm(challenge: string, expiresAt: number): void;
  /** The current wall-clock instant, injectable so the arming expiry is testable. */
  now(): number;
  /**
   * Resolve once the wallet can answer: its session restored and its agent
   * connected. A code opened from the camera cold-starts the app, and boot
   * restores the session without blocking navigation, so the card can mount
   * before there is an identity or a connected agent to read credentials from.
   */
  ready(): Promise<void>;
}

/** Wait for the identity store to finish restoring, then refresh the agent session. */
export async function walletReady(
  identity: { readonly isReady: boolean; readonly aidPrefix: string | null },
  keri: { ensureSession(): Promise<void> },
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<void> {
  if (!identity.isReady) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error('wallet did not finish restoring'));
      }, timeoutMs);
      const stop = watch(
        () => identity.isReady,
        (ready) => {
          if (!ready) return;
          clearTimeout(timer);
          stop();
          resolve();
        },
      );
    });
  }
  if (!identity.aidPrefix) throw new Error('no identity in this wallet');
  await keri.ensureSession();
}

function defaultDeps(): SigninDeps {
  const keri = useKERIClient();
  const identity = useIdentityStore();
  const sealPasscodeLive = makeSealPasscodeLive(identity);
  return {
    ready: () => walletReady(identity, keri),
    async listCredentials() {
      const client = keri.getSignifyClient();
      if (!client) return [];
      return (await client.credentials().list()) as HeldCredential[];
    },
    async exportCredential(said: string) {
      const client = keri.getSignifyClient();
      if (!client) throw new Error('KERI client not initialized');
      return (await client.credentials().get(said, true)) as unknown as string;
    },
    async sign(aid: string, message: string) {
      const signer = await getSigner(aid);
      return signer.sign(message);
    },
    present: presentToDoor,
    async schemaKinds() {
      const descriptor = await getCommunityDescriptor();
      const map: Record<string, string> = {};
      for (const [kind, schema] of Object.entries(descriptor.schemas)) {
        if (schema.said) map[schema.said] = kind;
      }
      return map;
    },
    sealingKeyFingerprint: (verkey) => fingerprintOf(verkey),
    now: () => Date.now(),
    // Arm the wallet to answer the panel's later request. The sealer reads the
    // passcode LIVE from the unlocked identity store at seal time and lets only
    // the ciphertext leave — never returned, never logged — so a wallet locked
    // between approve and the request seals nothing (#663/#674).
    arm: (challenge, expiresAt) => armForChallenge(challenge, expiresAt, sealPasscodeLive),
  };
}

/**
 * Seal the steward's held passcode to a verkey, reading the passcode live from
 * the unlocked identity store at seal time. Only the ciphertext leaves; the
 * passcode is never returned or logged. Bound into the arming so the panel's
 * later request seals to the key it holds, not to the sign-in code's `ek=`.
 */
function makeSealPasscodeLive(identity: { readonly passcode: string | null }): PasscodeSealer {
  return async (verkey: string) => {
    const bran = identity.passcode;
    if (!bran) return null;
    return sealPasscode(bran, verkey);
  };
}

/**
 * Whether the presented credential makes its holder a steward — its `role` is
 * `operator` (case-insensitive), the same rule that gates every steward surface
 * (ADR 0226; {@link STEWARD_ROLE}). A missing credential or role is not a
 * steward, so the unlock line is never offered without one (#663).
 */
function presenterIsSteward(cred: HeldCredential | null): boolean {
  return (cred?.sad?.a?.role ?? '').trim().toLowerCase() === STEWARD_ROLE;
}

export function useSignin(deps: SigninDeps = defaultDeps()) {
  const identity = useIdentityStore();
  const knownDoors = useKnownDoorsStore();

  const ask = shallowRef<SigninAsk | null>(null);
  const view = shallowRef<ApproveCardView | null>(null);
  const phase = ref<SigninPhase>('loading');
  const refusal = ref<RefusalCopy | null>(null);
  /** The credential the wallet will present (null → nothing matches; no Approve). */
  const chosen = shallowRef<HeldCredential | null>(null);
  /**
   * Whether the steward-unlock line is offered on this card (#663): true ONLY
   * when the sign-in is to the control panel (the code carried `ek=`) AND the
   * presented credential makes the holder a steward. Every other card leaves it
   * false and nothing is ever armed.
   */
  const unlockAvailable = ref(false);
  /** Whether the offered unlock line is switched on. On by default; the line IS
   *  the consent, so there is no second confirm (#663). Meaningless when
   *  {@link unlockAvailable} is false. */
  const unlockOn = ref(true);

  /**
   * Parse a `matou://signin` link and prepare the card, or return false when
   * the text is not a sign-in link. Loads the home-site mark and resolves the
   * credential (story 10/13).
   */
  async function prepareFromLink(text: string): Promise<boolean> {
    const parsed = parseSigninLink(text);
    if (!parsed) return false;
    await prepare(parsed);
    return true;
  }

  /**
   * Prepare the card from an already-parsed ask. Holds on `loading` until the
   * wallet is ready; any failure lands on `unavailable` (the try-again face),
   * never a card without its details.
   */
  async function prepare(parsed: SigninAsk): Promise<void> {
    ask.value = parsed;
    phase.value = 'loading';
    refusal.value = null;
    view.value = null;
    chosen.value = null;
    // Start disarmed and default-on for every fresh sign-in — arming is decided
    // below, only for a steward's control-panel sign-in.
    unlockAvailable.value = false;
    unlockOn.value = true;

    try {
      await deps.ready();
      await knownDoors.load();

      const aid = identity.aidPrefix ?? '';
      const creds = await deps.listCredentials();
      const cred = chooseCredential(creds, parsed.schemas, aid) ?? null;

      const kinds = await deps.schemaKinds();
      const toShow = cred ? describeCredential(cred, kinds) : null;
      chosen.value = cred;

      // The unlock line appears ONLY when the sign-in is to the control panel
      // (the code carried `ek=`) AND the presented credential makes the holder a
      // steward (its role is operator). The fingerprint rides the details
      // disclosure so a careful steward can compare it with the panel; it is
      // never on the face, and nothing is armed on any other card.
      let unlock: ApproveCardView['unlock'] = null;
      if (isPanelSignin(parsed) && presenterIsSteward(cred)) {
        const fingerprint = await deps.sealingKeyFingerprint(parsed.sealingKey ?? '');
        unlock = { sealingKeyFingerprint: fingerprint };
        unlockAvailable.value = true;
      }
      view.value = buildCardView(parsed, toShow, aid, knownDoors.isHome(parsed.door), unlock);
    } catch (err) {
      console.warn('[Signin] Could not prepare the sign-in:', err);
      phase.value = 'unavailable';
      return;
    }

    // A sign-in site the wallet has never met stops at the first-contact prompt
    // before any card (#535, story 11); the home site and any already-trusted
    // site skip straight to the approve card (story 12).
    phase.value = knownDoors.isKnown(parsed.door) ? 'card' : 'first-contact';
  }

  /** Try again from the `unavailable` face: prepare the same sign-in afresh. */
  async function retry(): Promise<void> {
    if (ask.value) await prepare(ask.value);
  }

  /**
   * Trust this sign-in site (WS-A1 "Trust this sign-in site", story 11): add it
   * to known doors under the name the code claimed and continue to the approve
   * card for the same sign-in.
   */
  async function trust(): Promise<void> {
    const a = ask.value;
    if (!a) return;
    await knownDoors.trust(a.door, a.community);
    phase.value = 'card';
  }

  /** Approve: sign, export, post, read the verdict (story 14/16/28). */
  async function approve(): Promise<void> {
    const a = ask.value;
    const cred = chosen.value;
    if (!a || !cred?.sad?.d) return;
    const aid = identity.aidPrefix ?? '';

    phase.value = 'proving';
    refusal.value = null;

    // Arm on approve, in the same act as the presentation: when this is a
    // steward's control-panel sign-in with the line on, keep the passcode ready
    // to seal for this challenge's life and answer the panel's LATER request
    // (#674). Nothing is sealed now and the present request below carries no
    // passcode. #663 sealed here, to the sign-in code's `ek=`, but that key
    // belongs to the bridge's door page the OIDC hop tears down — the panel at
    // `admin.<apex>` never held it, so the box could not be opened. The seal
    // happens when the panel asks with the verkey it actually minted (idss
    // #1957). Any other card, or the line switched off, arms nothing. A failure
    // to arm degrades to an ordinary locked-seat session rather than blocking the
    // sign-in — nothing but a later ciphertext ever leaves, so it is silent.
    if (unlockAvailable.value && unlockOn.value) {
      try {
        deps.arm(a.challenge, deps.now() + ARMING_TTL_MS);
      } catch {
        console.warn('[Signin] Could not arm the steward unlock; signing in with the seat locked');
      }
    }

    let verdict: PresentVerdict;
    try {
      verdict = await runApprove(
        {
          door: a.door,
          present: a.present,
          challenge: a.challenge,
          aid,
          credentialSaid: cred.sad.d,
        },
        {
          sign: (message) => deps.sign(aid, message),
          exportCredential: deps.exportCredential,
          present: deps.present,
        },
      );
    } catch {
      // A wallet-side failure (no signer, export error) is shown as the
      // wallet-only site-unreachable line rather than a door refusal — nothing
      // reached the door.
      verdict = { outcome: 'site-unreachable' };
    }

    if (verdict.outcome === 'verified') {
      // Only the known-doors entry changes on a completed sign-in (story 17).
      await knownDoors.touch(a.door);
      phase.value = 'done';
      return;
    }
    if (verdict.outcome === 'refused') {
      refusal.value = refusalCopy(verdict.refusal);
    } else {
      refusal.value = refusalCopy('site-unreachable');
    }
    phase.value = 'refused';
  }

  /** Switch the steward-unlock line on or off (PU-A2u, #663). The line is the
   *  consent, so this is the only gesture — there is no second confirm. */
  function setUnlock(on: boolean): void {
    unlockOn.value = on;
  }

  /** Not now: nothing was signed or posted; the page keeps waiting (story 15). */
  function notNow(): void {
    phase.value = 'card';
    refusal.value = null;
  }

  /** Try again after a refusal: back to the card for the page's fresh code
   * (WS-A2r). The try count lives on the page, never the wallet. */
  function tryAgain(): void {
    phase.value = 'card';
    refusal.value = null;
  }

  return {
    ask,
    view,
    phase,
    refusal,
    chosen,
    unlockAvailable,
    unlockOn,
    setUnlock,
    prepareFromLink,
    prepare,
    retry,
    trust,
    approve,
    notNow,
    tryAgain,
  };
}
