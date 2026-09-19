/**
 * The community space-ID door — recording the three any-sync space IDs on the
 * gateway (issue #534, idss #1608, ADR 0226 fallback ruling 2026-09-18).
 *
 * When the first steward's wallet creates a content-less community's spaces it
 * records them at the community's steward API (`api_url`). The door is proven
 * with the SAME present-as-holder machinery the sign-in approve card uses
 * (#531): a fetched challenge, a signature over the door-bound message, and the
 * bare ACDC+iss presentation — only the door address and the body (which also
 * carries the IDs) differ. No config-server admin token ever touches this path
 * (AC5, true by construction).
 *
 * The wire is idss's snake_case; the recorded IDs are read BACK from the
 * descriptor's `anysync` block under matou-app's own camelCase keys. Every
 * shape here is pinned by the shared golden fixture
 * (tests/scripts/fixtures/spaces-door/spaces-door-golden.json), copied from
 * idss so neither side guesses.
 */

import { boundMessage } from 'src/lib/signin/present';

/** The challenge route relative to `api_url` (golden `challenge_route.path`). */
export const CHALLENGE_PATH = '/spaces/challenge';
/** The record route relative to `api_url` (golden `post_route.path`). */
export const POST_PATH = '/spaces';

/** The single-use, two-minute challenge the door mints (golden challenge_route). */
export interface SpacesChallenge {
  /** The challenge id / nonce the bound message signs over. */
  challengeId: string;
  /** The door address to sign over — `<api_url>/spaces`, NOT the sign-in site. */
  door: string;
  /** ISO-8601 expiry (~2 minutes out); illustrative in the golden. */
  expiresAt: string;
}

/** The four-field proof the approve card posts, echoed to this door (snake_case). */
export interface SpacesProof {
  aid: string;
  challenge_id: string;
  /** The qb64 signature over the door-bound message. */
  response: string;
  /** The bare ACDC+iss CESR export (the same present-as-holder stream). */
  presentation: string;
}

/** The POST body: the three IDs (snake_case) plus the proof (golden post_route). */
export interface SpacesPostBody {
  community_space_id: string;
  read_only_space_id: string;
  admin_space_id: string;
  proof: SpacesProof;
}

/** The three IDs as the 409 conflict body carries them (snake_case). */
export interface RecordedSpacesWire {
  community_space_id: string;
  read_only_space_id: string;
  admin_space_id: string;
}

/**
 * The door's verdict on a record attempt.
 *  - `recorded`         204, the wallet's IDs are the community's (first write wins).
 *  - `already-recorded` 409, someone recorded first — re-read the descriptor and join.
 *  - `refused`          403/400/… the verifier's own `{code, message}` sentence.
 *  - `unreachable`      the post never landed (the community's records are down,
 *                       or the network failed) — retry later, nothing recorded.
 */
export type SpacesVerdict =
  | { outcome: 'recorded' }
  | { outcome: 'already-recorded'; spaces: RecordedSpacesWire }
  | { outcome: 'refused'; code: string; message: string }
  | { outcome: 'unreachable' };

/** Trim any trailing slashes so `api_url` + path never doubles up. */
function base(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '');
}

/**
 * GET `<api_url>/spaces/challenge` and read the challenge and the door address
 * to sign over. Returns `null` when the door cannot be reached or answers
 * anything but a well-formed 2xx challenge — the caller treats that as
 * unreachable and retries later (nothing is created on the strength of a
 * challenge alone). `fetchImpl` is injectable so tests drive it without a live
 * door.
 */
export async function fetchSpacesChallenge(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpacesChallenge | null> {
  const url = base(apiUrl) + CHALLENGE_PATH;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let parsed: { challenge_id?: string; door?: string; expires_at?: string } | null;
  try {
    parsed = (await res.json()) as { challenge_id?: string; door?: string; expires_at?: string } | null;
  } catch {
    return null;
  }
  const challengeId = parsed?.challenge_id ?? '';
  const door = parsed?.door ?? '';
  // Both the nonce and the door address are load-bearing: a signature over a
  // missing door is worthless, so refuse a half-answer rather than sign nothing.
  if (!challengeId || !door) return null;
  return { challengeId, door, expiresAt: parsed?.expires_at ?? '' };
}

/**
 * The door-bound message this door's proof signs over: the SAME shape the
 * approve card signs ({@link boundMessage} — `idss-idp:<door>:<aid>:<nonce>`),
 * but bound to the space-ID door's own address rather than the sign-in site's
 * (ADR 0226 fallback ruling step 2). Reusing the one signer means no second
 * signing scheme.
 */
export function spacesBoundMessage(door: string, aid: string, nonce: string): string {
  return boundMessage(door, aid, nonce);
}

/**
 * POST the three IDs and the proof to the door and map the answer to a
 * {@link SpacesVerdict}. 204 (or any 2xx) is recorded; 409 is already-recorded,
 * carrying the winning IDs; any other non-2xx is a refusal with the verifier's
 * own `{code, message}`; a thrown fetch is unreachable — never mistaken for a
 * refusal. `fetchImpl` is injectable for tests.
 */
export async function postSpacesToDoor(
  door: string,
  body: SpacesPostBody,
  fetchImpl: typeof fetch = fetch,
): Promise<SpacesVerdict> {
  let res: Response;
  try {
    res = await fetchImpl(door, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { outcome: 'unreachable' };
  }

  if (res.ok) {
    return { outcome: 'recorded' };
  }

  // Every error body is the shared `{code, message}` problem shape; 409 adds a
  // `spaces` block. Read defensively — a body that will not parse still refuses.
  type ProblemBody = { code?: string; message?: string; spaces?: RecordedSpacesWire };
  let parsed: ProblemBody | null = null;
  try {
    parsed = (await res.json()) as ProblemBody;
  } catch {
    parsed = null;
  }

  if (res.status === 409) {
    const spaces: RecordedSpacesWire = {
      community_space_id: parsed?.spaces?.community_space_id ?? '',
      read_only_space_id: parsed?.spaces?.read_only_space_id ?? '',
      admin_space_id: parsed?.spaces?.admin_space_id ?? '',
    };
    return { outcome: 'already-recorded', spaces };
  }

  return {
    outcome: 'refused',
    code: parsed?.code ?? 'refused',
    message: parsed?.message ?? 'The community refused to record the spaces.',
  };
}
