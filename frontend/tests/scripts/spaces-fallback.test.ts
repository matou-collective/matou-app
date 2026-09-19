/**
 * The first steward's space-creation fallback orchestration (issue #534, idss
 * #1495 story 26, ADR 0226 spaces amendment). Create → prove → record, and on a
 * 409 re-read the descriptor and join the recorded spaces — never force its own
 * (AC2). Driven with fakes: no signify-ts, no live door, no any-sync.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  decideFallbackPosture,
  runSpaceFallback,
  type SpaceFallbackDeps,
} from 'src/lib/spaces/fallback';
import { parseDescriptor, type RecordedSpaces } from 'src/lib/descriptor';

import goldenAnysync from './fixtures/descriptor/golden-anysync.json';
import goldenAnysyncSpaces from './fixtures/descriptor/golden-anysync-spaces.json';
import goldenNoAnysync from './fixtures/descriptor/golden-no-anysync.json';
import doorGolden from './fixtures/spaces-door/spaces-door-golden.json';

const CREATED: RecordedSpaces = {
  communitySpaceId: 'bafyMine.1',
  readOnlySpaceId: 'bafyMine.2',
  adminSpaceId: 'bafyMine.3',
};

const API_URL = 'https://whakatohea.idss.nz/api/v1/idip';
const DOOR = doorGolden.challenge_route.response.door;
const CHALLENGE = doorGolden.challenge_route.response.challenge_id;

function deps(over: Partial<SpaceFallbackDeps> = {}): SpaceFallbackDeps {
  return {
    createSpaces: vi.fn(async () => CREATED),
    fetchChallenge: vi.fn(async () => ({ challengeId: CHALLENGE, door: DOOR, expiresAt: '' })),
    sign: vi.fn(async () => '0Bsignature'),
    exportCredential: vi.fn(async () => '{"v":"ACDC10JSON000064_","d":"E"}...'),
    postSpaces: vi.fn(async () => ({ outcome: 'recorded' as const })),
    rereadDescriptor: vi.fn(async () => parseDescriptor(goldenAnysyncSpaces)),
    recordSpacesLocally: vi.fn(async () => undefined),
    ...over,
  };
}

describe('decideFallbackPosture', () => {
  it('no content layer → nothing (empty state)', () => {
    expect(decideFallbackPosture(parseDescriptor(goldenNoAnysync)).posture).toBe('no-content-layer');
  });

  it('any-sync present, no IDs → this ticket\'s create-fallback', () => {
    expect(decideFallbackPosture(parseDescriptor(goldenAnysync)).posture).toBe('create-fallback');
  });

  it('IDs already recorded → join, never create/post (AC4)', () => {
    const d = decideFallbackPosture(parseDescriptor(goldenAnysyncSpaces));
    expect(d.posture).toBe('join-recorded');
    expect(d.recorded?.communitySpaceId).toContain('bafyreicommunityspace');
  });
});

describe('runSpaceFallback', () => {
  const input = { apiUrl: API_URL, aid: 'EOperatorBenAID00000000000000000000000000000', credentialSaid: 'ECredSAID' };

  it('creates, proves and records the wallet\'s own spaces on 204 (AC1)', async () => {
    const d = deps();
    const result = await runSpaceFallback(input, d);
    expect(result).toEqual({ outcome: 'created', spaces: CREATED });

    // Created BEFORE posting; signed over the DOOR address (not the sign-in site).
    expect(d.createSpaces).toHaveBeenCalled();
    expect(d.sign).toHaveBeenCalledWith(`idss-idp:${DOOR}:${input.aid}:${CHALLENGE}`);

    // Posted the three IDs + the four-field proof to the door.
    const [door, body] = (d.postSpaces as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(door).toBe(DOOR);
    expect(body).toMatchObject({
      community_space_id: CREATED.communitySpaceId,
      read_only_space_id: CREATED.readOnlySpaceId,
      admin_space_id: CREATED.adminSpaceId,
      proof: { aid: input.aid, challenge_id: CHALLENGE, response: '0Bsignature', presentation: expect.any(String) },
    });
    expect(d.recordSpacesLocally).toHaveBeenCalledWith(CREATED);
  });

  it('on 409 re-reads the descriptor and JOINS the recorded spaces (AC2)', async () => {
    const conflictSpaces = doorGolden.post_route.conflict.body.spaces;
    const d = deps({
      postSpaces: vi.fn(async () => ({ outcome: 'already-recorded' as const, spaces: conflictSpaces })),
    });
    const result = await runSpaceFallback(input, d);

    // Joined the DESCRIPTOR's canonical IDs, not its own created ones.
    expect(result.outcome).toBe('joined');
    expect(d.rereadDescriptor).toHaveBeenCalled();
    if (result.outcome === 'joined') {
      expect(result.spaces.communitySpaceId).toContain('bafyreicommunityspace');
      expect(result.spaces).not.toEqual(CREATED);
    }
    expect(d.recordSpacesLocally).toHaveBeenCalledWith(
      expect.objectContaining({ communitySpaceId: expect.stringContaining('bafyreicommunityspace') }),
    );
  });

  it('on 409 falls back to the conflict echo when the descriptor has not caught up', async () => {
    const conflictSpaces = doorGolden.post_route.conflict.body.spaces;
    const d = deps({
      postSpaces: vi.fn(async () => ({ outcome: 'already-recorded' as const, spaces: conflictSpaces })),
      // descriptor still names no IDs (record not yet merged in)
      rereadDescriptor: vi.fn(async () => parseDescriptor(goldenAnysync)),
    });
    const result = await runSpaceFallback(input, d);
    expect(result).toEqual({
      outcome: 'joined',
      spaces: {
        communitySpaceId: conflictSpaces.community_space_id,
        readOnlySpaceId: conflictSpaces.read_only_space_id,
        adminSpaceId: conflictSpaces.admin_space_id,
      },
    });
  });

  it('a door refusal carries the verifier\'s own sentence and records nothing', async () => {
    const refusal = doorGolden.post_route.refusals.not_operator;
    const d = deps({
      postSpaces: vi.fn(async () => ({ outcome: 'refused' as const, code: refusal.body.code, message: refusal.body.message })),
    });
    const result = await runSpaceFallback(input, d);
    expect(result).toEqual({ outcome: 'refused', code: refusal.body.code, message: refusal.body.message });
    expect(d.recordSpacesLocally).not.toHaveBeenCalled();
  });

  it('an unreachable challenge leaves the spaces uncorded (retry later)', async () => {
    const d = deps({ fetchChallenge: vi.fn(async () => null) });
    const result = await runSpaceFallback(input, d);
    expect(result).toEqual({ outcome: 'unreachable' });
    expect(d.postSpaces).not.toHaveBeenCalled();
    expect(d.recordSpacesLocally).not.toHaveBeenCalled();
  });

  it('never sends a config-server admin token — only the IDs and the proof (AC5)', async () => {
    const d = deps();
    await runSpaceFallback(input, d);
    const [, body] = (d.postSpaces as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // The body is exactly the three space IDs plus the present-as-holder proof;
    // there is no bearer/admin token field, so AC5 holds by construction.
    expect(Object.keys(body as object).sort()).toEqual([
      'admin_space_id',
      'community_space_id',
      'proof',
      'read_only_space_id',
    ]);
    // The proof carries only the four present-as-holder fields — a signed
    // challenge and the presented credential, never a shared secret.
    expect(Object.keys((body as { proof: object }).proof).sort()).toEqual([
      'aid',
      'challenge_id',
      'presentation',
      'response',
    ]);
  });
});
