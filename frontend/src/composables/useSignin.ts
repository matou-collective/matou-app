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
 * When the door answers `revoked`, the wallet remembers it of the credential it
 * presented and passes over that credential from then on (#690). The refused
 * code is spent, so nothing more is presented on it: what the wallet holds
 * instead — at the control panel, a steward's Membership — rides the next code.
 *
 * The card has two forms, and the code says which (#688; idss ADR 0282 as
 * amended 2026-09-29). A **sign-in** is the card above — with the unlock line,
 * on by default, when the code offers a seat unlock and the wallet's identity
 * is a steward (PU-A2u). An **unlock** — a locked panel unlocking through this
 * same door — is the same card with the unlock as its act and no switch
 * (PU-A4): Unlock presents, arms, and answers the panel's request (PU-A4d).
 * Opened by an identity that is not a steward, an unlock says so and posts
 * nothing (PU-A4n).
 *
 * The KERI-side dependencies are injected (defaults wired to the real client
 * and stores) so the phase machine and view model are unit-testable without
 * signify-ts or a live door.
 */

import { computed, ref, shallowRef, watch } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { getCommunityDescriptor } from 'src/lib/clientConfig';
import { useIdentityStore } from 'src/stores/identity';
import { useKnownDoorsStore } from 'src/stores/knownDoors';
import { parseSigninLink, isUnlockAsk, offersSeatUnlock, type SigninAsk } from 'src/lib/signin/link';
import {
  askedCredentialName,
  chooseCredential,
  credentialCard,
  describeCredential,
  type HeldCredential,
} from 'src/lib/signin/credential';
import { forgetRevoked, rememberRevoked } from 'src/lib/signin/revokedMemory';
import { identityIsSteward } from 'src/lib/signin/steward';
import { sealPasscode } from 'src/lib/signin/sealedPasscode';
import { armForChallenge, type PasscodeSealer } from 'src/lib/signin/armedPasscode';
import { runHandover } from 'src/lib/signin/handover';
import { buildCardView, type ApproveCardView } from 'src/lib/signin/view';
import { runApprove } from 'src/lib/signin/approve';
import { dropSigner, getSigner } from 'src/lib/signin/signer';
import { presentToDoor, type PresentBody, type PresentVerdict } from 'src/lib/signin/present';
import { refusalCopy, type RefusalCopy, type RevokedFallback } from 'src/lib/signin/refusal';

/**
 * The card's faces. `loading` holds until the wallet is ready and the card is
 * built; `unavailable` is the try-again fallback when it could not be.
 * `first-contact` (WS-A1) comes *before* the card when the ask names a sign-in
 * site the wallet has never met (#535); `no-credential` replaces the card when
 * the wallet holds nothing the door asks for (#683); `not-a-steward` replaces
 * it when the code says it is an unlock and the wallet's identity is not a
 * steward (PU-A4n, #688); the rest are the approve card and its follow-ons
 * (WS-A2/A2p/A2d/A2r — and, in the unlock form, PU-A4/A4d).
 */
export type SigninPhase =
  | 'loading'
  | 'unavailable'
  | 'first-contact'
  | 'no-credential'
  | 'not-a-steward'
  | 'card'
  | 'proving'
  | 'done'
  | 'refused';

/**
 * The card's form, which the code decides (#688): an ordinary `signin`, or an
 * `unlock` — a code that says it is one (`offer=unlock`).
 */
export type SigninForm = 'signin' | 'unlock';

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
  /**
   * Forget the cached signer for `aid`, so the next sign resolves afresh. Called
   * when the door answers `signature`: the door verifies against the identity's
   * newest key state, so a signer it refused must not sign the retry.
   */
  forgetSigner?(aid: string): void;
  /** POST the presentation to a URL and read the verdict. */
  present(presentUrl: string, body: PresentBody): Promise<PresentVerdict>;
  /** schema SAID → descriptor kind key (e.g. "membership"), for the label. */
  schemaKinds(): Promise<Record<string, string>>;
  /**
   * Arm the wallet to seal the steward's passcode when the panel later asks, for
   * the challenge that lives until `expiresAt` (wall-clock ms). Called ONLY for
   * a steward — on a control-panel sign-in approved with the unlock line on, or
   * on an unlock (#688); it seals nothing now — the box the panel can open is
   * minted only when the panel asks, to the verkey it holds (#674). The passcode
   * never leaves this wallet's unlocked session (#663).
   */
  arm(challenge: string, expiresAt: number): void;
  /**
   * Answer the panel's later request for an armed control-panel sign-in (#674):
   * read the verkey the panel bound to the door and seal the passcode to it,
   * once (idss #1961). Called ONLY after an armed panel sign-in verifies, and
   * run in the background — it never blocks or fails the sign-in, and a panel
   * that never lands simply leaves the poll unanswered. Nothing but the sealed
   * ciphertext ever leaves this wallet's unlocked session.
   */
  answerHandover(presentUrl: string, challenge: string, aid: string): Promise<void>;
  /** The current wall-clock instant, injectable so the arming expiry is testable. */
  now(): number;
  /**
   * Resolve once the wallet can answer: its session restored and its agent
   * connected. A code opened from the camera cold-starts the app, and boot
   * restores the session without blocking navigation, so the card can mount
   * before there is an identity or a connected agent to read credentials from.
   */
  ready(): Promise<void>;
  /**
   * Admit the credentials the community issued this member that the wallet has
   * not yet accepted (issue #685). Called only when the wallet holds nothing
   * the door asks for — a code scanned cold opens this card, not the dashboard
   * whose poll admits them.
   */
  admitPending?(): Promise<void>;
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
    async admitPending() {
      // Loaded only when a door asks for something the wallet does not hold.
      const { admitPendingCommunityGrants } = await import('src/lib/keri/communityGrants');
      await admitPendingCommunityGrants(identity.aidPrefix);
    },
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
    forgetSigner: dropSigner,
    present: presentToDoor,
    async schemaKinds() {
      const descriptor = await getCommunityDescriptor();
      const map: Record<string, string> = {};
      for (const [kind, schema] of Object.entries(descriptor.schemas)) {
        if (schema.said) map[schema.said] = kind;
      }
      return map;
    },
    now: () => Date.now(),
    // Arm the wallet to answer the panel's later request. The sealer reads the
    // passcode LIVE from the unlocked identity store at seal time and lets only
    // the ciphertext leave — never returned, never logged — so a wallet locked
    // between approve and the request seals nothing (#663/#674).
    arm: (challenge, expiresAt) => armForChallenge(challenge, expiresAt, sealPasscodeLive),
    // Answer the panel's later request: poll the door for the verkey the panel
    // bound and seal to it once (#674). Best-effort — runHandover never throws
    // and seals nothing when the panel never binds or the seat is locked.
    answerHandover: (presentUrl, challenge, aid) => runHandover(presentUrl, challenge, aid),
  };
}

/**
 * Seal the steward's held passcode to a verkey, reading the passcode live from
 * the unlocked identity store at seal time. Only the ciphertext leaves; the
 * passcode is never returned or logged. Bound into the arming so the panel's
 * later request seals to the key the panel holds — the one it bound at the door
 * after it landed. No sign-in code carries a sealing key (#688).
 */
function makeSealPasscodeLive(identity: { readonly passcode: string | null }): PasscodeSealer {
  return async (verkey: string) => {
    const bran = identity.passcode;
    if (!bran) return null;
    return sealPasscode(bran, verkey);
  };
}

export function useSignin(deps: SigninDeps = defaultDeps()) {
  const identity = useIdentityStore();
  const knownDoors = useKnownDoorsStore();

  const ask = shallowRef<SigninAsk | null>(null);
  const view = shallowRef<ApproveCardView | null>(null);
  const phase = ref<SigninPhase>('loading');
  const refusal = ref<RefusalCopy | null>(null);
  /**
   * The challenge id the door answered as a stale code (`spent`, `expired` or
   * `unknown`, #675). A sign-in code is single-use, so once the door has spent
   * or expired one, re-presenting it can only be refused again. We remember it
   * so the card waits for a freshly-minted code rather than re-posting the dead
   * one on "try again" — the newest challenge always wins.
   *
   * A code the door answered `revoked` on is held the same way (#690): the
   * attempt spent it, and the credential the wallet would present instead must
   * ride a fresh code, never this one.
   */
  const spentChallenge = shallowRef<string | null>(null);
  /**
   * Whether the challenge the wallet is currently holding is that dead code.
   * Derived, so a fresh `prepare` carrying a *different* challenge clears it
   * automatically (the newest code wins) while a re-navigation to the same
   * spent code keeps Approve held (#675).
   */
  const staleCode = computed(
    () => spentChallenge.value !== null && ask.value?.challenge === spentChallenge.value,
  );
  /** The credential the wallet will present (null → nothing matches; no Approve). */
  const chosen = shallowRef<HeldCredential | null>(null);
  /**
   * What the card was built from — every credential the wallet held and the
   * community's names for their kinds — kept so a `revoked` answer can say what
   * the wallet will present next without asking the agent again (#690).
   */
  const held = shallowRef<readonly HeldCredential[]>([]);
  const schemaKinds = shallowRef<Record<string, string>>({});
  /**
   * Whether anything was posted to the door for this sign-in. The no-credential
   * screen is usually the wallet's own finding — nothing presented, nothing
   * posted — and says so; it must not say so when the door itself answered
   * `no-credential` to a presentation (#683).
   */
  const posted = ref(false);
  /**
   * The card's form, read from the code's own offer field (#688): `unlock` when
   * the code says it is an unlock, `signin` otherwise. Known from the ask alone,
   * so the loading and unavailable faces already speak of the right thing.
   */
  const form = computed<SigninForm>(() => (ask.value && isUnlockAsk(ask.value) ? 'unlock' : 'signin'));
  /**
   * Whether the wallet's identity is one of the community's stewards
   * ({@link identityIsSteward} — the one place that is read). Decides who is
   * offered the unlock line and who may unlock; false until the card is built.
   */
  const steward = ref(false);
  /**
   * Whether the steward-unlock line is offered on this card (PU-A2u): true ONLY
   * when the code offers a seat unlock AND the wallet's identity is a steward.
   * Every other card leaves it false. An unlock has no line — it has no switch.
   */
  const unlockAvailable = ref(false);
  /** Whether the offered unlock line is switched on. On by default; the line IS
   *  the consent, so there is no second confirm (#663). Meaningless when
   *  {@link unlockAvailable} is false. */
  const unlockOn = ref(true);
  /**
   * Whether the sign-in that verified ARMED the wallet to answer the panel — a
   * steward's control-panel sign-in approved with the line on, or an unlock.
   * True only once the door has verified it; false for every other sign-in.
   */
  const armed = ref(false);
  /**
   * Whether the done face must stay until it is closed, rather than close
   * itself after a beat (WS-A2d). True after an armed sign-in or an unlock
   * verifies: the handover happens AFTER that face appears — the panel lands,
   * binds its key and asks; the wallet seals and answers — so the face carries
   * the one instruction that matters, to keep the app open until Members
   * appears (PU-A2u, PU-A4d). An app closed at once leaves the panel signed in
   * and locked.
   */
  const keepOpen = computed(() => phase.value === 'done' && (armed.value || form.value === 'unlock'));

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
    held.value = [];
    schemaKinds.value = {};
    posted.value = false;
    // Start disarmed and default-on for every fresh sign-in — arming is decided
    // below, only for a steward, and only when the code offers it.
    steward.value = false;
    unlockAvailable.value = false;
    unlockOn.value = true;
    armed.value = false;

    try {
      await deps.ready();
      await knownDoors.load();

      const aid = identity.aidPrefix ?? '';
      let creds = await deps.listCredentials();
      // The credential the door asked for: the one it named (`cred=`), else
      // the first of an asked schema as before (#683).
      let cred = chooseCredential(creds, parsed.schemas, aid, parsed.credential) ?? null;
      if (!cred && deps.admitPending) {
        // It may have been issued and be waiting to be accepted (#685).
        try {
          await deps.admitPending();
          creds = await deps.listCredentials();
          cred = chooseCredential(creds, parsed.schemas, aid, parsed.credential) ?? null;
        } catch (err) {
          console.warn('[Signin] Could not admit pending credentials:', err);
        }
      }

      const kinds = await deps.schemaKinds();
      held.value = creds;
      schemaKinds.value = kinds;

      // Whether there is a seat to unlock is the wallet's to decide, from
      // whether its identity is a steward (idss ADR 0282, ruling 3).
      steward.value = identityIsSteward(cred, creds, parsed.schemas, aid);

      // A code that says it is an unlock, opened by an identity that is not a
      // steward, presents NOTHING (PU-A4n): the person is already signed in, so
      // a presentation would only repeat the sign-in. Holding Administrator
      // does not change that — there is no seat behind it.
      if (isUnlockAsk(parsed) && !steward.value) cred = null;

      const toShow = cred ? describeCredential(cred, kinds, parsed.community) : null;
      chosen.value = cred;

      // The unlock line appears ONLY when the code OFFERS a seat unlock — read
      // from its own field, never from a sealing key, the service's display
      // name or the credential asked for — AND the identity is a steward.
      // Nothing is armed on any other card.
      unlockAvailable.value = offersSeatUnlock(parsed) && steward.value;
      view.value = buildCardView(
        parsed,
        toShow,
        aid,
        knownDoors.isHome(parsed.door),
        unlockAvailable.value,
        askedCredentialName(parsed.credential, parsed.schemas, kinds),
      );
    } catch (err) {
      console.warn('[Signin] Could not prepare the sign-in:', err);
      phase.value = 'unavailable';
      return;
    }

    // An unlock this identity cannot make: say so, on its own screen (PU-A4n).
    // Nothing is presented and nothing is posted — so, as with no-credential,
    // there is nothing to trust an unmet site with.
    if (isUnlockAsk(parsed) && !steward.value) {
      phase.value = 'not-a-steward';
      return;
    }

    // The wallet holds nothing this door asks for: say so, on its own screen
    // (#683). Nothing is presented and nothing is posted — so there is nothing
    // to trust an unmet site with, and the first-contact prompt is skipped.
    if (!chosen.value) {
      phase.value = 'no-credential';
      return;
    }

    // A sign-in site the wallet has never met stops at the first-contact prompt
    // before any card (#535, story 11); the home site and any already-trusted
    // site skip straight to the approve card (story 12).
    phase.value = knownDoors.isKnown(parsed.door) ? 'card' : 'first-contact';
  }

  /**
   * What the wallet will present on the NEXT code, now that the door has
   * answered `revoked` to `refused` — named for the refusal's copy (#690). Null
   * when it holds nothing else this door admits: the choice is
   * `chooseCredential`'s, which passes over what the door called revoked, and
   * on an unlock only a steward has anything to present.
   */
  function fallbackAfter(a: SigninAsk, refused: HeldCredential, aid: string): RevokedFallback | null {
    const next = chooseCredential(held.value, a.schemas, aid, a.credential);
    if (!next?.sad?.d || next.sad.d === refused.sad?.d) return null;
    if (isUnlockAsk(a) && !identityIsSteward(next, held.value, a.schemas, aid)) return null;
    return {
      revoked: credentialCard(refused, schemaKinds.value, a.community).name,
      next: credentialCard(next, schemaKinds.value, a.community).name,
    };
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
    // An identity that is not a steward cannot unlock, and posts nothing
    // (PU-A4n). It has no card to press; this holds even if called.
    if (phase.value === 'not-a-steward') return;
    // Never re-present a code the door has already spent or expired — it can
    // only be refused again. The card waits for a freshly-minted challenge
    // instead (#675).
    if (staleCode.value) return;
    const aid = identity.aidPrefix ?? '';
    const unlocking = isUnlockAsk(a);

    phase.value = 'proving';
    refusal.value = null;
    armed.value = false;

    // Arm on approve, in the same act as the presentation: a steward's
    // control-panel sign-in with the line on, or a steward's Unlock — which has
    // no switch, the unlock being the only reason its card exists (#688). The
    // wallet keeps the passcode ready to seal for this challenge's life and
    // answers the panel's LATER request (#674). Nothing is sealed now and the
    // present request below carries no passcode — only `armed: true`, so the
    // door mints the handover capability. The seal happens after the sign-in
    // verifies, when the wallet reads the verkey the panel bound at the door
    // and seals to it (answerHandover, idss #1961). Any other card, or the
    // line switched off, arms nothing.
    let arming = false;
    if (unlocking ? steward.value : unlockAvailable.value && unlockOn.value) {
      try {
        deps.arm(a.challenge, deps.now() + ARMING_TTL_MS);
        arming = true;
      } catch {
        if (unlocking) {
          // An unlock that cannot arm has nothing to do: presenting unarmed
          // would only sign the person in again, to a panel that stays locked,
          // behind a face that says it is unlocking. Post nothing; offer the
          // try-again face.
          console.warn('[Signin] Could not arm the steward unlock; nothing was sent');
          phase.value = 'unavailable';
          return;
        }
        // At sign-in a failure to arm degrades to an ordinary locked-seat
        // session rather than blocking the sign-in — nothing but a later
        // ciphertext ever leaves, so it is silent.
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
          // Only a wallet that actually armed rides `armed: true`, so the door
          // mints the handover capability only when there is a passcode ready to
          // seal. An arm that threw degrades to an ordinary locked seat.
          armed: arming,
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
      // The door read this credential as live on the witnessed ledger, so
      // anything remembered of an earlier `revoked` answer to it is cleared.
      forgetRevoked(cred.sad.d);
      // Only the known-doors entry changes on a completed sign-in (story 17).
      await knownDoors.touch(a.door);
      // Said before the done face shows, so the face it shows is the right one.
      armed.value = arming;
      phase.value = 'done';
      // Answer the panel's later request in the background (#674): read the
      // verkey the panel bound to the door and seal the passcode to it, once.
      // Fire-and-forget — the sign-in is already done (the app says "Signed
      // in" and to keep it open, or after an unlock "Unlocking that computer"),
      // the box arrives a moment later, and a panel that never lands just
      // leaves the poll unanswered. It never blocks or fails the sign-in, and
      // nothing but the sealed ciphertext ever leaves.
      if (arming) {
        void deps.answerHandover(a.present, a.challenge, aid).catch(() => {
          /* the answer is best-effort; a failure never touches the sign-in */
        });
      }
      return;
    }
    if (verdict.outcome === 'refused') {
      refusal.value = refusalCopy(verdict.refusal);
      // The signature did not verify against the identity's newest key state.
      // Drop the signer so "try again" resolves one from the keys the identity
      // holds now, rather than signing with the refused one again.
      if (refusal.value.kind === 'signature') deps.forgetSigner?.(aid);
      // The door says the credential presented is not the one it asks for. A
      // wallet that reads `cred=` should never cause it; when it happens it is
      // the same screen as holding none (#683).
      if (refusal.value.kind === 'no-credential') {
        posted.value = true;
        phase.value = 'no-credential';
        return;
      }
      // The door read the witnessed ledger and found this credential revoked;
      // the wallet's own view is older. Remember it of this ONE credential, so
      // the next code passes over it (#690) — and only for this refusal: no
      // other kind says anything about the credential's standing. The attempt
      // spent the code, so it is held like any dead one, and the copy says what
      // the next code will present when the wallet holds something else this
      // door admits.
      if (refusal.value.kind === 'revoked') {
        rememberRevoked(cred.sad.d);
        spentChallenge.value = a.challenge;
        refusal.value = refusalCopy(verdict.refusal, fallbackAfter(a, cred, aid));
      }
      // A stale-code refusal (the door said this challenge is spent/expired/
      // unknown) means the held code is dead: remember it so "try again" waits
      // for a fresh one rather than re-posting it (#675).
      if (
        refusal.value.kind === 'spent' ||
        refusal.value.kind === 'expired' ||
        refusal.value.kind === 'unknown'
      ) {
        spentChallenge.value = a.challenge;
      }
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

  /** Not now: nothing was signed or posted; the page keeps waiting (story 15).
   *  The same on an unlock: nothing is sent, and the door keeps waiting until
   *  its code expires (PU-A4). */
  function notNow(): void {
    if (phase.value === 'no-credential' || phase.value === 'not-a-steward') return;
    phase.value = 'card';
    refusal.value = null;
  }

  /** Try again after a refusal: back to the card for the page's fresh code
   * (WS-A2r). The try count lives on the page, never the wallet. When the held
   * code is one the door already spent or expired, there is nothing to go back
   * to — re-presenting it can only be refused again — so we hold the stale-code
   * refusal (its copy asks the member to start the sign-in again) until a fresh
   * challenge arrives and supersedes it (#675). A `revoked` refusal is held the
   * same way (#690). */
  function tryAgain(): void {
    if (staleCode.value) return;
    phase.value = 'card';
    refusal.value = null;
  }

  return {
    ask,
    view,
    phase,
    refusal,
    chosen,
    posted,
    staleCode,
    form,
    armed,
    keepOpen,
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
