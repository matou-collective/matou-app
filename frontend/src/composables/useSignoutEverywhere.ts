/**
 * useSignoutEverywhere — the identity screen's "Sign out of the control panel
 * everywhere" action (#665, idss #1935, ADR 0282 d.4, flow panel-unlock W5).
 *
 * Resolves the community descriptor, the steward's own AID and the cached signer,
 * derives the apex take-back door and runs the signed request (src/lib/panel/
 * signout). It exposes a small state machine the row renders — idle → working →
 * done | failed — and never throws into the caller: a wallet-side error, a
 * refusal or an unreachable community all land as `failed`, so the row states the
 * failure plainly and NEVER claims sessions were ended (AC4).
 *
 * The KERI- and network-side effects are injected (production defaults wired to
 * the real client, stores and door) so the orchestration is unit-testable without
 * signify-ts or a live door.
 */

import { ref } from 'vue';
import { getCommunityDescriptor } from 'src/lib/clientConfig';
import { useIdentityStore } from 'src/stores/identity';
import { getSigner } from 'src/lib/signin/signer';
import type { CommunityDescriptor } from 'src/lib/descriptor';
import {
  panelSignoutDoor,
  postPanelSignout,
  runPanelSignoutEverywhere,
  type PanelSignoutBody,
  type PanelSignoutVerdict,
} from 'src/lib/panel/signout';

/** The row's state machine. */
export type SignoutEverywhereStatus = 'idle' | 'working' | 'done' | 'failed';

/** Injectable side-effects; production defaults resolve the real client/stores. */
export interface SignoutEverywhereDeps {
  /** The parsed community backend descriptor. */
  getDescriptor(): Promise<CommunityDescriptor>;
  /** The steward's own AID (the identity that holds the panel sessions). */
  holderAid(): string;
  /** Sign a UTF-8 message, returning the qb64 signature. */
  sign(message: string): Promise<string>;
  /** POST the take-back to the door. */
  post(door: string, body: PanelSignoutBody): Promise<PanelSignoutVerdict>;
  /** The wallet's monotonic Unix-ms timestamp / replay guard. */
  now(): number;
}

function defaultDeps(): SignoutEverywhereDeps {
  const identity = useIdentityStore();
  const aid = (): string => identity.aidPrefix ?? '';
  return {
    getDescriptor: getCommunityDescriptor,
    holderAid: aid,
    sign: async (message: string) => (await getSigner(aid())).sign(message),
    post: (door: string, body: PanelSignoutBody) => postPanelSignout(door, body),
    now: () => Date.now(),
  };
}

export function useSignoutEverywhere(deps: SignoutEverywhereDeps = defaultDeps()) {
  const status = ref<SignoutEverywhereStatus>('idle');

  /**
   * Run the take-back once. Idempotent against a double-press: it no-ops while a
   * request is in flight or already done, so a second click cannot fire a second
   * (replayed) request.
   */
  async function signOut(): Promise<void> {
    if (status.value === 'working' || status.value === 'done') return;
    status.value = 'working';

    let descriptor: CommunityDescriptor;
    try {
      descriptor = await deps.getDescriptor();
    } catch {
      status.value = 'failed';
      return;
    }

    const door = panelSignoutDoor({
      apiUrl: descriptor.api_url,
      signinUrl: descriptor.signin?.url,
    });
    const aid = deps.holderAid();
    if (!door || !aid) {
      // No door to reach (a non-IDSS / not-yet-founded backend) or no identity to
      // sign as — nothing was sent, so nothing changed.
      status.value = 'failed';
      return;
    }

    try {
      const verdict = await runPanelSignoutEverywhere(
        { door, aid, signedAt: deps.now() },
        { sign: deps.sign, post: deps.post },
      );
      status.value = verdict.outcome === 'signed-out' ? 'done' : 'failed';
    } catch {
      // A wallet-side failure (the signer produced nothing) — the request never
      // completed, so nothing claims sessions were ended.
      status.value = 'failed';
    }
  }

  /** Return to the row's resting state so the steward can try again after a failure. */
  function reset(): void {
    status.value = 'idle';
  }

  return { status, signOut, reset };
}
