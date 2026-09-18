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

import { ref, shallowRef } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { getCommunityDescriptor } from 'src/lib/clientConfig';
import { useIdentityStore } from 'src/stores/identity';
import { useKnownDoorsStore } from 'src/stores/knownDoors';
import { parseSigninLink, type SigninAsk } from 'src/lib/signin/link';
import { chooseCredential, describeCredential, type HeldCredential } from 'src/lib/signin/credential';
import { buildCardView, type ApproveCardView } from 'src/lib/signin/view';
import { runApprove } from 'src/lib/signin/approve';
import { getSigner } from 'src/lib/signin/signer';
import { presentToDoor, type PresentBody, type PresentVerdict } from 'src/lib/signin/present';
import { refusalCopy, type RefusalCopy } from 'src/lib/signin/refusal';

/** The card's four faces (WS-A2/A2p/A2d/A2r). */
export type SigninPhase = 'card' | 'proving' | 'done' | 'refused';

/** Injectable side-effects; production defaults resolve the real client/stores. */
export interface SigninDeps {
  /** All credentials the wallet holds. */
  listCredentials(): Promise<HeldCredential[]>;
  /** Export a credential's full `includeCESR` stream by SAID. */
  exportCredential(said: string): Promise<string>;
  /** Sign a bound message with the member's cached signer. */
  sign(aid: string, message: string): Promise<string>;
  /** POST the presentation and read the verdict. */
  present(door: string, body: PresentBody): Promise<PresentVerdict>;
  /** schema SAID → descriptor kind key (e.g. "membership"), for the label. */
  schemaKinds(): Promise<Record<string, string>>;
}

function defaultDeps(): SigninDeps {
  const keri = useKERIClient();
  return {
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
  };
}

export function useSignin(deps: SigninDeps = defaultDeps()) {
  const identity = useIdentityStore();
  const knownDoors = useKnownDoorsStore();

  const ask = shallowRef<SigninAsk | null>(null);
  const view = shallowRef<ApproveCardView | null>(null);
  const phase = ref<SigninPhase>('card');
  const refusal = ref<RefusalCopy | null>(null);
  /** The credential the wallet will present (null → nothing matches; no Approve). */
  const chosen = shallowRef<HeldCredential | null>(null);

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

  /** Prepare the card from an already-parsed ask. */
  async function prepare(parsed: SigninAsk): Promise<void> {
    ask.value = parsed;
    phase.value = 'card';
    refusal.value = null;
    await knownDoors.load();

    const aid = identity.aidPrefix ?? '';
    const creds = await deps.listCredentials();
    const cred = chooseCredential(creds, parsed.schemas, aid) ?? null;
    chosen.value = cred;

    const kinds = await deps.schemaKinds();
    const toShow = cred ? describeCredential(cred, kinds) : null;
    view.value = buildCardView(parsed, toShow, aid, knownDoors.isHome(parsed.door));
  }

  /** Approve: sign, export, post, read the verdict (story 14/16/28). */
  async function approve(): Promise<void> {
    const a = ask.value;
    const cred = chosen.value;
    if (!a || !cred?.sad?.d) return;
    const aid = identity.aidPrefix ?? '';

    phase.value = 'proving';
    refusal.value = null;

    let verdict: PresentVerdict;
    try {
      verdict = await runApprove(
        { door: a.door, challenge: a.challenge, aid, credentialSaid: cred.sad.d },
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

  return { ask, view, phase, refusal, chosen, prepareFromLink, prepare, approve, notNow, tryAgain };
}
