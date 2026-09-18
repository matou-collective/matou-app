/**
 * The fallback controller's boot decision (issue #534). Given injected deps it
 * gates every posture: no content layer / already recorded / no steward
 * credential are all no-ops; only a steward-credential-holder against an
 * any-sync-but-no-IDs descriptor runs the create-and-record fallback.
 */
import { describe, it, expect, vi } from 'vitest';
import { useSpaceFallback, type SpaceFallbackControllerDeps } from 'src/composables/useSpaceFallback';
import { parseDescriptor } from 'src/lib/descriptor';
import type { HeldCredential } from 'src/lib/signin/credential';
import type { SpaceFallbackDeps } from 'src/lib/spaces/fallback';

import goldenAnysync from './fixtures/descriptor/golden-anysync.json';
import goldenAnysyncSpaces from './fixtures/descriptor/golden-anysync-spaces.json';
import goldenNoAnysync from './fixtures/descriptor/golden-no-anysync.json';

const COMMUNITY = 'ECommunityGroupAID000000000000000000000000000';
const MEMBERSHIP = 'EMembershipSchemaSAID00000000000000000000000';
const ME = 'EOperatorBenAID00000000000000000000000000000';

const stewardCred: HeldCredential = {
  sad: { d: 'ECred', i: COMMUNITY, s: MEMBERSHIP, a: { i: ME, role: 'operator' } },
};
const memberCred: HeldCredential = {
  sad: { d: 'ECred2', i: COMMUNITY, s: MEMBERSHIP, a: { i: ME, role: 'member' } },
};

function fallbackDeps(): SpaceFallbackDeps {
  return {
    createSpaces: vi.fn(async () => ({ communitySpaceId: 'c', readOnlySpaceId: 'r', adminSpaceId: 'a' })),
    fetchChallenge: vi.fn(async () => ({ challengeId: 'n', door: 'https://d/spaces', expiresAt: '' })),
    sign: vi.fn(async () => '0Bsig'),
    exportCredential: vi.fn(async () => 'stream'),
    postSpaces: vi.fn(async () => ({ outcome: 'recorded' as const })),
    rereadDescriptor: vi.fn(async () => parseDescriptor(goldenAnysyncSpaces)),
    recordSpacesLocally: vi.fn(async () => undefined),
  };
}

function deps(descriptor: unknown, creds: HeldCredential[], fb = fallbackDeps()): SpaceFallbackControllerDeps {
  return {
    getDescriptor: vi.fn(async () => parseDescriptor(descriptor)),
    listCredentials: vi.fn(async () => creds),
    holderAid: () => ME,
    fallback: fb,
  };
}

describe('useSpaceFallback.run — posture gating', () => {
  it('no content layer → none, creates nothing', async () => {
    const fb = fallbackDeps();
    const action = await useSpaceFallback(deps(goldenNoAnysync, [stewardCred], fb)).run();
    expect(action).toEqual({ action: 'none', reason: 'no-content-layer' });
    expect(fb.createSpaces).not.toHaveBeenCalled();
  });

  it('IDs already recorded → none, nothing created or posted (AC4)', async () => {
    const fb = fallbackDeps();
    const action = await useSpaceFallback(deps(goldenAnysyncSpaces, [stewardCred], fb)).run();
    expect(action).toEqual({ action: 'none', reason: 'already-recorded' });
    expect(fb.createSpaces).not.toHaveBeenCalled();
    expect(fb.postSpaces).not.toHaveBeenCalled();
  });

  it('any-sync, no IDs, no steward credential → none, creates nothing (AC3)', async () => {
    const fb = fallbackDeps();
    const action = await useSpaceFallback(deps(goldenAnysync, [memberCred], fb)).run();
    expect(action).toEqual({ action: 'none', reason: 'not-steward' });
    expect(fb.createSpaces).not.toHaveBeenCalled();
  });

  it('any-sync, no IDs, steward credential → runs the fallback (AC1)', async () => {
    const fb = fallbackDeps();
    const action = await useSpaceFallback(deps(goldenAnysync, [memberCred, stewardCred], fb)).run();
    expect(action.action).toBe('fallback');
    if (action.action === 'fallback') expect(action.result.outcome).toBe('created');
    expect(fb.createSpaces).toHaveBeenCalled();
    expect(fb.postSpaces).toHaveBeenCalled();
  });

  it('a descriptor that cannot be read is a safe no-op', async () => {
    const d = deps(goldenAnysync, [stewardCred]);
    d.getDescriptor = vi.fn(async () => {
      throw new Error('config server down');
    });
    expect(await useSpaceFallback(d).run()).toEqual({ action: 'none', reason: 'no-descriptor' });
  });
});
