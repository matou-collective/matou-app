/**
 * The community space-ID door client (issue #534, idss #1608, ADR 0226 fallback
 * ruling). Every shape is pinned by the shared golden fixture copied from idss
 * (internal/controlapi/testdata/spaces-door-golden.json) — a drift on either
 * side reds this test, so neither repo guesses the wire.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  fetchSpacesChallenge,
  postSpacesToDoor,
  spacesBoundMessage,
  CHALLENGE_PATH,
  type SpacesPostBody,
} from 'src/lib/spaces/door';

import golden from './fixtures/spaces-door/spaces-door-golden.json';

const API_URL = 'https://whakatohea.idss.nz/api/v1/idip';

const body: SpacesPostBody = golden.post_route.request_with_proof;

describe('spacesBoundMessage', () => {
  it('binds to the DOOR address, not the sign-in site (ADR 0226 ruling step 2)', () => {
    // The same prefix the approve card signs, over the door's own address.
    expect(spacesBoundMessage(golden.challenge_route.response.door, 'Etama', 'n1')).toBe(
      'idss-idp:https://whakatohea.idss.nz/api/v1/idip/spaces:Etama:n1',
    );
  });
});

describe('fetchSpacesChallenge', () => {
  it('GETs <api_url>/spaces/challenge and reads the challenge + door', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(golden.challenge_route.response), { status: 200 }));
    const challenge = await fetchSpacesChallenge(API_URL, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(API_URL + CHALLENGE_PATH, expect.objectContaining({ method: 'GET' }));
    expect(challenge).toEqual({
      challengeId: golden.challenge_route.response.challenge_id,
      door: golden.challenge_route.response.door,
      expiresAt: golden.challenge_route.response.expires_at,
    });
  });

  it('trims a trailing slash on api_url so the path never doubles', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(golden.challenge_route.response), { status: 200 }));
    await fetchSpacesChallenge(API_URL + '/', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(API_URL + CHALLENGE_PATH, expect.anything());
  });

  it('returns null (unreachable) on a thrown fetch', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchSpacesChallenge(API_URL, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it('returns null on a non-2xx or a half-answer (missing door)', async () => {
    const bad = vi.fn(async () => new Response('{}', { status: 503 }));
    expect(await fetchSpacesChallenge(API_URL, bad as unknown as typeof fetch)).toBeNull();
    const half = vi.fn(async () => new Response(JSON.stringify({ challenge_id: 'x' }), { status: 200 }));
    expect(await fetchSpacesChallenge(API_URL, half as unknown as typeof fetch)).toBeNull();
  });
});

describe('postSpacesToDoor', () => {
  const door = golden.challenge_route.response.door;

  it('204 is recorded (first write wins)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: golden.post_route.recorded.status }));
    const verdict = await postSpacesToDoor(door, body, fetchImpl as unknown as typeof fetch);
    expect(verdict).toEqual({ outcome: 'recorded' });
    // Posts to the door address, with the IDs + proof body.
    expect(fetchImpl).toHaveBeenCalledWith(door, expect.objectContaining({ method: 'POST' }));
    const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent).toEqual(body);
    expect(sent.proof).toMatchObject({ aid: expect.any(String), challenge_id: expect.any(String) });
  });

  it('409 is already-recorded, carrying the winning IDs (AC2)', async () => {
    const conflict = golden.post_route.conflict;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(conflict.body), { status: conflict.status }));
    const verdict = await postSpacesToDoor(door, body, fetchImpl as unknown as typeof fetch);
    expect(verdict).toEqual({ outcome: 'already-recorded', spaces: conflict.body.spaces });
  });

  it('maps each refusal to its verifier sentence (403 not_operator / credential_rejected)', async () => {
    for (const key of ['not_operator', 'credential_rejected'] as const) {
      const refusal = golden.post_route.refusals[key];
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(refusal.body), { status: refusal.status }));
      const verdict = await postSpacesToDoor(door, body, fetchImpl as unknown as typeof fetch);
      expect(verdict).toEqual({ outcome: 'refused', code: refusal.body.code, message: refusal.body.message });
    }
  });

  it('records_unreachable (503) is a refusal with its own sentence — retry later', async () => {
    const refusal = golden.post_route.refusals.records_unreachable;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(refusal.body), { status: refusal.status }));
    const verdict = await postSpacesToDoor(door, body, fetchImpl as unknown as typeof fetch);
    expect(verdict).toEqual({ outcome: 'refused', code: refusal.body.code, message: refusal.body.message });
  });

  it('a thrown fetch is unreachable, never a refusal', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await postSpacesToDoor(door, body, fetchImpl as unknown as typeof fetch)).toEqual({ outcome: 'unreachable' });
  });

  it('a non-2xx with an unreadable body still refuses', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 400 }));
    const verdict = await postSpacesToDoor(door, body, fetchImpl as unknown as typeof fetch);
    expect(verdict.outcome).toBe('refused');
  });
});
