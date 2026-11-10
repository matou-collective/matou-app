/**
 * The wallet's answer to the panel's request for the sealed passcode (matou-app
 * #674, idss #1961/#1967, ADR 0282 d.2/d.6 + its armed-consent amendment).
 *
 * A steward approves a control-panel sign-in with the unlock line ON, so the
 * wallet ARMS ({@link armForChallenge}) and posts `armed: true` — no box — on
 * present. The door then mints a single-use handover capability and delivers it
 * to the freshly-landed panel over the OIDC channel; the panel mints an Ed25519
 * keypair in its tab and BINDS the verkey to the door against this sign-in's
 * challenge. This module is the wallet's half of what happens next: holding the
 * challenge from the scan, it reads the verkey the panel bound off the door's
 * key route, seals the steward's live passcode to it ({@link sealForRequest} —
 * single-use, read live from the unlocked identity store), and posts the
 * ciphertext to the door's seal route, which relays it to the panel exactly
 * once. One tap on the phone; no second scan; NO secret in any URL.
 *
 * The wire is the sign-in bridge's APP DOOR golden `sign_in_armed_handover`
 * (idss `internal/idp/testdata/app-door-golden.json`, copied to
 * `tests/scripts/fixtures/app-door/app-door-golden.json`). Both routes are
 * siblings of the present route: the ask carries `present_url = <base>/present`,
 * so the wallet reads `<base>/handover/key?c=<challenge>` and posts to
 * `<base>/handover/seal`. Derived from `present_url` (the one address the wallet
 * posts to), NEVER from `door` (#1669).
 *
 * The panel lands only after the OIDC hop, and asks the door only once its
 * Members tab is open, so the wallet polls the key route for AS LONG AS THE
 * CHALLENGE LIVES — two minutes (golden `panel.challenge`) — and stops the moment
 * the door says the challenge is dead. On the first live steward unlock
 * (Whakatōhea Demo, 2026-09-30) the wallet gave up after ~10 s and the panel first
 * asked at 11 s. A panel that was backgrounded or never came back leaves the poll
 * unanswered until the door expires the challenge, lands on PU-M0x cause 1, and
 * nothing is sealed. The passcode leaves only as the sealed cipher, is never
 * logged, and never rides a URL.
 */

import { sealForRequest } from './armedPasscode';

/** The wallet's read of the bound verkey (golden `wallet_key.answered.body`). */
interface HandoverKeyResponse {
  /** The PUBLIC verkey the panel bound, or absent (`{}`) until it has. */
  sealing_key?: string;
}

/** The snake_case box the wallet posts (golden `wallet_seal.request`). */
interface HandoverSealBody {
  challenge_id: string;
  aid: string;
  /** The steward's passcode sealed to the panel's verkey (CESR qb64 cipher). */
  sealed_passcode: string;
}

/**
 * The door's wallet-facing key route for a challenge: `<base>/handover/key?c=…`,
 * a sibling of the present route (`<base>/present`). Resolved relative to
 * `present_url`, never derived from `door`.
 */
export function handoverKeyUrl(presentUrl: string, challenge: string): string {
  const url = new URL('handover/key', presentUrl);
  url.searchParams.set('c', challenge);
  return url.toString();
}

/** The door's wallet-facing seal route: `<base>/handover/seal`, sibling of present. */
export function handoverSealUrl(presentUrl: string): string {
  return new URL('handover/seal', presentUrl).toString();
}

/** The side-effects the answer needs, injected so the poll loop is testable
 *  without real timers, a live door, or signify-ts. */
export interface HandoverDeps {
  /** Seal the armed passcode to the verkey ONCE (armedPasscode.sealForRequest). */
  seal: (challenge: string, sealingVerkey: string) => Promise<string | null>;
  /** The fetch to reach the door (native in production; faked in tests). */
  fetchImpl: typeof fetch;
  /** Sleep between polls (injected so tests advance the loop instantly). */
  sleep: (ms: number) => Promise<void>;
}

/** How long to wait between key-route polls. */
const POLL_INTERVAL_MS = 1000;
/** How long the door's challenge lives (golden `panel.challenge`, two minutes) —
 *  the panel may bind at any point in it, so the wallet waits it out, plus a
 *  margin for the door's own clock. The door answers non-200 once the challenge
 *  is dead, which ends the wait early. */
const CHALLENGE_LIFE_MS = 120_000;
const MAX_WAIT_MS = CHALLENGE_LIFE_MS + 15_000;

function defaultHandoverDeps(): HandoverDeps {
  return {
    seal: (challenge, sealingVerkey) => sealForRequest(challenge, sealingVerkey),
    fetchImpl: fetch,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * Read the verkey the panel bound for this challenge, or null when it has not
 * bound one yet (`{}`), the challenge is unknown/dead (non-200), or the door
 * could not be reached. Only a PUBLIC key ever rides this wire.
 */
/** One read of the key route: the verkey once the panel has bound (`{}` until then),
 *  or `dead` when the door answers non-200 — an expired, spent or unknown challenge
 *  (golden `wallet_key.expired`), after which no poll can succeed. A network fault
 *  is neither: the door may be back on the next poll. */
async function readBoundVerkey(
  keyUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ verkey: string | null; dead: boolean }> {
  let res: Response;
  try {
    res = await fetchImpl(keyUrl, { method: 'GET' });
  } catch {
    return { verkey: null, dead: false };
  }
  if (res.status !== 200) return { verkey: null, dead: true };
  let body: HandoverKeyResponse | null = null;
  try {
    body = (await res.json()) as HandoverKeyResponse | null;
  } catch {
    return { verkey: null, dead: false };
  }
  const key = (body?.sealing_key ?? '').trim();
  return { verkey: key || null, dead: false };
}

/**
 * Post the sealed box to the door's seal route. Best-effort: a throw (the box
 * never landed) is swallowed — the arming is already consumed (single-use), so
 * there is nothing to retry and nothing but the ciphertext ever left.
 */
async function postSealedBox(
  sealUrl: string,
  body: HandoverSealBody,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    await fetchImpl(sealUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // The post never landed; nothing to do — the single-use arming is spent.
  }
}

/**
 * Answer the panel's request for this armed sign-in: poll the door for the
 * verkey the panel bound, seal the passcode to it once, and post the box. Gives
 * up quietly when the panel never binds inside the budget, when the wallet holds
 * no live passcode (locked seat), or when the arming was already consumed — in
 * every such case nothing is sealed. Never throws.
 */
export async function runHandover(
  presentUrl: string,
  challenge: string,
  aid: string,
  deps: HandoverDeps = defaultHandoverDeps(),
): Promise<void> {
  const keyUrl = handoverKeyUrl(presentUrl, challenge);

  let verkey: string | null = null;
  for (let waitedMs = 0; waitedMs <= MAX_WAIT_MS; waitedMs += POLL_INTERVAL_MS) {
    const read = await readBoundVerkey(keyUrl, deps.fetchImpl);
    if (read.dead) return; // the door says the challenge is over — nothing is sealed
    if (read.verkey) {
      verkey = read.verkey;
      break;
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
  if (!verkey) return; // the panel never bound in the challenge's life — nothing is sealed (PU-M0x cause 1)

  // Seal to the verkey the panel actually holds, ONCE. A locked seat, a missing
  // passcode, or an already-consumed arming all yield null — nothing leaves.
  const cipher = await deps.seal(challenge, verkey);
  if (!cipher) return;

  await postSealedBox(
    handoverSealUrl(presentUrl),
    { challenge_id: challenge, aid, sealed_passcode: cipher },
    deps.fetchImpl,
  );
}
