/**
 * The first steward's space-creation fallback (issue #534, idss #1495 story 26,
 * ADR 0226 spaces amendment).
 *
 * Founding creates a community's three any-sync spaces itself (idss T10). This
 * is the tail: an operator who chose "later", a community founded before that
 * slice, or a founding run that could not reach any-sync. A wallet lands
 * against a gateway whose descriptor carries `anysync` but names no space IDs;
 * if it holds a steward credential it creates the three spaces exactly as
 * founding does — through the shared `communityspace` package, reached over the
 * backend — and records the IDs at the community's steward API with the
 * present-as-holder proof (#531). Nothing else of org setup runs.
 *
 * This module is the pure orchestration: the KERI-, network- and store-side
 * effects are injected, so the whole create → prove → record → (join-on-409)
 * path is unit-testable against the shared golden fixture with no signify-ts,
 * no live door and no any-sync.
 */

import {
  hasContentLayer,
  recordedSpaces,
  type CommunityDescriptor,
  type RecordedSpaces,
} from 'src/lib/descriptor';
import { trimPresentation } from 'src/lib/signin/credential';
import {
  fetchSpacesChallenge,
  spacesBoundMessage,
  type RecordedSpacesWire,
  type SpacesPostBody,
  type SpacesVerdict,
} from './door';

/**
 * The boot posture the descriptor implies for the content layer.
 *  - `no-content-layer` any-sync is not installed — the content surfaces show
 *                       their empty state and nothing is created or posted.
 *  - `join-recorded`    the three space IDs are already in the descriptor —
 *                       nothing is created or posted (AC4); joining them is the
 *                       normal boot path, not this fallback.
 *  - `create-fallback`  any-sync present, no IDs recorded — this ticket's case.
 */
export type FallbackPosture = 'no-content-layer' | 'join-recorded' | 'create-fallback';

/** The posture and, when already recorded, the IDs to join. */
export interface PostureDecision {
  posture: FallbackPosture;
  /** The recorded IDs, only for `join-recorded`. */
  recorded?: RecordedSpaces;
}

/**
 * Decide the content-layer posture from the descriptor. `create-fallback` is
 * the only posture this ticket's fallback acts on; the other two are inert
 * here (AC4 holds by construction — recorded IDs mean no create, no post).
 */
export function decideFallbackPosture(d: CommunityDescriptor): PostureDecision {
  if (!hasContentLayer(d)) return { posture: 'no-content-layer' };
  const recorded = recordedSpaces(d);
  if (recorded) return { posture: 'join-recorded', recorded };
  return { posture: 'create-fallback' };
}

/** What the fallback needs, resolved by the composable (or faked in tests). */
export interface SpaceFallbackInput {
  /** The community steward API base — the descriptor's `api_url`. */
  apiUrl: string;
  /** The signing (steward/holder) AID. */
  aid: string;
  /** The SAID of the steward credential to present. */
  credentialSaid: string;
}

/** The side-effecting dependencies, injected for testability. */
export interface SpaceFallbackDeps {
  /**
   * Create the community's three spaces through the shared package (over the
   * backend) and return their IDs. Founding's own creation is out of scope;
   * this is the same package, MA1.
   */
  createSpaces(): Promise<RecordedSpaces>;
  /** GET the door's challenge and the address to sign over. */
  fetchChallenge(apiUrl: string): Promise<Awaited<ReturnType<typeof fetchSpacesChallenge>>>;
  /** Sign a bound message with the member's cached signer. */
  sign(message: string): Promise<string>;
  /** Export the steward credential's full `includeCESR` stream by SAID. */
  exportCredential(said: string): Promise<string>;
  /** POST the IDs and proof to the door and read the verdict. */
  postSpaces(door: string, body: SpacesPostBody): Promise<SpacesVerdict>;
  /**
   * Re-read the descriptor (after a 409) so the join uses the canonical record,
   * not the 409 echo. Returns the fresh descriptor.
   */
  rereadDescriptor(): Promise<CommunityDescriptor>;
  /** Adopt the chosen three IDs locally (org-config + identity); never creates. */
  recordSpacesLocally(spaces: RecordedSpaces): Promise<void>;
}

/**
 * The fallback's outcome.
 *  - `created`     the wallet's spaces are the community's (204) and recorded.
 *  - `joined`      the wallet lost the race (409); it joined the recorded spaces.
 *  - `refused`     the door refused the proof; nothing recorded (the verifier's
 *                  own sentence is carried through).
 *  - `unreachable` the door could not be reached; nothing recorded — retry later.
 */
export type SpaceFallbackResult =
  | { outcome: 'created'; spaces: RecordedSpaces }
  | { outcome: 'joined'; spaces: RecordedSpaces }
  | { outcome: 'refused'; code: string; message: string }
  | { outcome: 'unreachable' };

/** Map the door's snake_case 409 echo to the descriptor's camelCase shape. */
function fromWire(w: RecordedSpacesWire): RecordedSpaces {
  return {
    communitySpaceId: w.community_space_id,
    readOnlySpaceId: w.read_only_space_id,
    adminSpaceId: w.admin_space_id,
  };
}

/** True when all three IDs are present and non-empty. */
function whole(s: RecordedSpaces | null | undefined): s is RecordedSpaces {
  return !!s && !!s.communitySpaceId && !!s.readOnlySpaceId && !!s.adminSpaceId;
}

/**
 * Run the fallback: create the three spaces, prove steward standing at the
 * door, record the IDs — and on a 409 conflict re-read the descriptor and join
 * the recorded spaces instead, never forcing its own (AC2).
 *
 * The caller must have already established that the posture is `create-fallback`
 * AND that the wallet holds a steward credential; a wallet with none never
 * reaches here (AC3). Throws only on a genuine wallet-side failure the caller
 * should surface (a missing signer, an export error); a door refusal or an
 * unreachable door is a {@link SpaceFallbackResult}, not an exception.
 */
export async function runSpaceFallback(
  input: SpaceFallbackInput,
  deps: SpaceFallbackDeps,
): Promise<SpaceFallbackResult> {
  const { apiUrl, aid, credentialSaid } = input;

  // Create the three spaces first — the door records IDs, so we need them.
  const created = await deps.createSpaces();

  // Fetch the challenge and the door address to sign OVER (the door's own
  // address, not the sign-in site's). A door we cannot reach leaves the spaces
  // uncorded; nothing is remembered, retry later.
  const challenge = await deps.fetchChallenge(apiUrl);
  if (!challenge) return { outcome: 'unreachable' };

  // Reuse #531's present-as-holder exactly: export + trim to ACDC+iss, sign the
  // door-bound message, post the IDs plus the four-field proof.
  const presentation = trimPresentation(await deps.exportCredential(credentialSaid));
  const response = await deps.sign(spacesBoundMessage(challenge.door, aid, challenge.challengeId));

  const body: SpacesPostBody = {
    community_space_id: created.communitySpaceId,
    read_only_space_id: created.readOnlySpaceId,
    admin_space_id: created.adminSpaceId,
    proof: { aid, challenge_id: challenge.challengeId, response, presentation },
  };

  const verdict = await deps.postSpaces(challenge.door, body);

  if (verdict.outcome === 'recorded') {
    await deps.recordSpacesLocally(created);
    return { outcome: 'created', spaces: created };
  }

  if (verdict.outcome === 'already-recorded') {
    // Lost the race. The canonical re-read is the descriptor (AC2); the 409
    // echo only confirms we lost, and is the fallback when the descriptor has
    // not caught up to the record yet.
    const fresh = await deps.rereadDescriptor();
    const fromDescriptor = recordedSpaces(fresh);
    const toJoin = whole(fromDescriptor) ? fromDescriptor : fromWire(verdict.spaces);
    await deps.recordSpacesLocally(toJoin);
    return { outcome: 'joined', spaces: toJoin };
  }

  if (verdict.outcome === 'refused') {
    return { outcome: 'refused', code: verdict.code, message: verdict.message };
  }

  return { outcome: 'unreachable' };
}
