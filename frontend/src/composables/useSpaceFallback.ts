/**
 * useSpaceFallback — the first steward's space-creation fallback controller
 * (issue #534, idss #1495 story 26, ADR 0226 spaces amendment).
 *
 * Run once after the descriptor loads and the member's identity is restored
 * (the boot call site this ticket owns). It decides the content-layer posture
 * and, only in the create-fallback case AND only when the wallet holds a
 * steward credential, creates the three spaces through the shared package (over
 * the backend) and records the IDs at the community's steward API with the
 * present-as-holder proof (#531). A wallet with no steward credential creates
 * nothing — the content surfaces keep their empty state (AC3).
 *
 * The KERI-, network- and store-side effects are injected (production defaults
 * wired to the real client, stores and door) so the decision and the
 * orchestration are unit-testable without signify-ts, a live door or any-sync.
 */

import { getCommunityDescriptor } from 'src/lib/clientConfig';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'src/stores/identity';
import { getSigner } from 'src/lib/signin/signer';
import type { HeldCredential } from 'src/lib/signin/credential';
import { type CommunityDescriptor, type RecordedSpaces } from 'src/lib/descriptor';
import { findStewardCredential } from 'src/lib/spaces/steward';
import {
  fetchSpacesChallenge,
  postSpacesToDoor,
  type SpacesPostBody,
} from 'src/lib/spaces/door';
import {
  decideFallbackPosture,
  runSpaceFallback,
  type SpaceFallbackDeps,
  type SpaceFallbackResult,
} from 'src/lib/spaces/fallback';
import { BACKEND_URL, setBackendIdentity } from 'src/lib/api/client';
import { secureStorage } from 'src/lib/secureStorage';

/** The outcome of one fallback run, for logging and the boot caller. */
export type SpaceFallbackAction =
  | { action: 'none'; reason: 'no-content-layer' | 'already-recorded' | 'not-steward' | 'no-descriptor' }
  | { action: 'fallback'; result: SpaceFallbackResult };

/** Injectable side-effects; production defaults resolve the real client/stores. */
export interface SpaceFallbackControllerDeps {
  /** The parsed community backend descriptor. */
  getDescriptor(): Promise<CommunityDescriptor>;
  /** All credentials the wallet holds. */
  listCredentials(): Promise<HeldCredential[]>;
  /** This member's AID. */
  holderAid(): string;
  /** The orchestration's own side-effects. */
  fallback: SpaceFallbackDeps;
}

function defaultDeps(): SpaceFallbackControllerDeps {
  const keri = useKERIClient();
  const identity = useIdentityStore();

  const listCredentials = async (): Promise<HeldCredential[]> => {
    const client = keri.getSignifyClient();
    if (!client) return [];
    return (await client.credentials().list()) as HeldCredential[];
  };

  const exportCredential = async (said: string): Promise<string> => {
    const client = keri.getSignifyClient();
    if (!client) throw new Error('KERI client not initialized');
    return (await client.credentials().get(said, true)) as unknown as string;
  };

  const aid = (): string => identity.aidPrefix ?? '';

  const createSpaces = async (): Promise<RecordedSpaces> => {
    // The same shared package founding runs, reached over the backend
    // (POST /api/v1/spaces/community derives keys from the stored mnemonic and
    // calls communityspace.CreateCommunitySpaces). The community identity
    // already exists; this adds only the content layer.
    const descriptor = await getCommunityDescriptor();
    const res = await fetch(`${BACKEND_URL}/api/v1/spaces/community`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgAid: descriptor.community?.aid ?? '',
        orgName: descriptor.community?.name ?? '',
        adminAid: aid(),
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`space creation failed: ${res.status}`);
    const body = (await res.json()) as {
      communitySpaceId?: string;
      readOnlySpaceId?: string;
      adminSpaceId?: string;
      spaceId?: string;
    };
    return {
      communitySpaceId: body.communitySpaceId ?? body.spaceId ?? '',
      readOnlySpaceId: body.readOnlySpaceId ?? '',
      adminSpaceId: body.adminSpaceId ?? '',
    };
  };

  const recordSpacesLocally = async (spaces: RecordedSpaces): Promise<void> => {
    // Point the backend at the chosen IDs (the ones we created, or the recorded
    // ones we joined on a 409) and refresh the identity store's view. The IDs
    // derive from this steward's mnemonic, so the backend reuses reachable
    // spaces rather than minting fresh ones (issue #539 convention).
    const mnemonic = (await secureStorage.getItem('matou_mnemonic')) ?? '';
    const orgAid = (await secureStorage.getItem('matou_org_aid')) ?? undefined;
    if (mnemonic) {
      await setBackendIdentity({
        aid: aid(),
        mnemonic,
        orgAid,
        communitySpaceId: spaces.communitySpaceId,
        readOnlySpaceId: spaces.readOnlySpaceId,
        adminSpaceId: spaces.adminSpaceId,
        mode: 'claim',
      });
    }
    await identity.fetchUserSpaces();
  };

  return {
    getDescriptor: getCommunityDescriptor,
    listCredentials,
    holderAid: aid,
    fallback: {
      createSpaces,
      fetchChallenge: (apiUrl: string) => fetchSpacesChallenge(apiUrl),
      sign: async (message: string) => (await getSigner(aid())).sign(message),
      exportCredential,
      postSpaces: (door: string, body: SpacesPostBody) => postSpacesToDoor(door, body),
      rereadDescriptor: getCommunityDescriptor,
      recordSpacesLocally,
    },
  };
}

export function useSpaceFallback(deps: SpaceFallbackControllerDeps = defaultDeps()) {
  /**
   * Decide and, when it applies, run the fallback. Best-effort: it never throws
   * into the boot path — a wallet-side failure surfaces as an `unreachable`
   * result and the content surfaces keep their empty state until a later run.
   */
  async function run(): Promise<SpaceFallbackAction> {
    let descriptor: CommunityDescriptor;
    try {
      descriptor = await deps.getDescriptor();
    } catch {
      return { action: 'none', reason: 'no-descriptor' };
    }

    const { posture } = decideFallbackPosture(descriptor);
    // anysync absent → no content layer; the three IDs present → join is the
    // normal boot path, not this fallback. Either way nothing is created or
    // posted (AC4 holds by construction).
    if (posture === 'no-content-layer') return { action: 'none', reason: 'no-content-layer' };
    if (posture === 'join-recorded') return { action: 'none', reason: 'already-recorded' };

    // create-fallback: only a steward-credential-holder acts (AC1/AC3).
    const creds = await deps.listCredentials();
    const cred = findStewardCredential(creds, {
      communityAid: descriptor.community?.aid ?? '',
      ...(descriptor.schemas.membership?.said
        ? { membershipSchema: descriptor.schemas.membership.said }
        : {}),
      holderAid: deps.holderAid(),
    });
    if (!cred?.sad?.d) return { action: 'none', reason: 'not-steward' };

    const result = await runSpaceFallback(
      { apiUrl: descriptor.api_url ?? '', aid: deps.holderAid(), credentialSaid: cred.sad.d },
      deps.fallback,
    );
    return { action: 'fallback', result };
  }

  return { run };
}
