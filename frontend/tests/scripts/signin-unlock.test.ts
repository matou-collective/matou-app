/**
 * The control-panel UNLOCK path (idss #1929 story 14–16, wireframe PU-A4;
 * matou-app #664). The unlock-only card seals the steward's passcode to the
 * FRESH per-page key the unlock code carried and posts it ONCE — no credential
 * is presented and no session is minted. postUnlock reads the door's verdict the
 * same honest way the present route does; buildUnlockView is the pure card model;
 * useUnlock is the phase machine (loading → card → unlocking → done / refused,
 * plus the clean `expired` refusal at read time).
 *
 * The heavy KERI/store modules are mocked so only the controller's logic runs;
 * side-effects come in through injected deps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('src/lib/keri/client', () => ({
  useKERIClient: () => ({ getSignifyClient: () => null, ensureSession: async () => undefined }),
}));
vi.mock('src/stores/identity', () => ({ useIdentityStore: () => ({ aidPrefix: 'EHa', passcode: 'abcdefghijklmnopqrstu' }) }));

import { postUnlock, type UnlockBody } from 'src/lib/signin/unlock';
import { buildUnlockView } from 'src/lib/signin/view';
import { useUnlock, type UnlockDeps } from 'src/composables/useUnlock';
import type { PresentVerdict } from 'src/lib/signin/present';
import type { UnlockAsk } from 'src/lib/signin/link';

const RELAY = 'https://id.example.nz/login/app/unlock';
const body: UnlockBody = { challenge_id: 'u_2d7', sealed_passcode: '1AAHsealed' };

/** Fulfil a response with an HTTP code + JSON body. */
function respond(spec: { status: number; body: unknown }): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(spec.body), { status: spec.status })) as unknown as typeof fetch;
}

describe('postUnlock', () => {
  it('posts the sealed box to the relay URL verbatim and reads verified', async () => {
    const fetchImpl = respond({ status: 200, body: { status: 'verified' } });
    const verdict = await postUnlock(RELAY, body, fetchImpl);
    expect(verdict).toEqual({ outcome: 'verified' });
    expect(fetchImpl).toHaveBeenCalledWith(
      RELAY,
      expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } }),
    );
    const sent = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    // No aid, no response, no presentation — the passcode and only the passcode.
    expect(sent).toEqual({ challenge_id: 'u_2d7', sealed_passcode: '1AAHsealed' });
  });

  it('maps 410 and status:expired to an expired refusal (dead challenge)', async () => {
    expect(await postUnlock(RELAY, body, respond({ status: 410, body: {} }))).toEqual({
      outcome: 'refused',
      refusal: 'expired',
    });
    expect(await postUnlock(RELAY, body, respond({ status: 200, body: { status: 'expired' } }))).toEqual({
      outcome: 'refused',
      refusal: 'expired',
    });
  });

  it('maps 409 spent and a refused body, and fails closed on garble', async () => {
    expect(await postUnlock(RELAY, body, respond({ status: 409, body: {} }))).toMatchObject({ refusal: 'spent' });
    expect(await postUnlock(RELAY, body, respond({ status: 200, body: { status: 'refused', refusal: 'signature' } }))).toEqual(
      { outcome: 'refused', refusal: 'signature' },
    );
    // A 2xx with no status never reads as verified.
    expect(await postUnlock(RELAY, body, respond({ status: 200, body: {} }))).toMatchObject({ outcome: 'refused' });
  });

  it('is site-unreachable when the post throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await postUnlock(RELAY, body, fetchImpl)).toEqual({ outcome: 'site-unreachable' });
  });
});

describe('buildUnlockView', () => {
  it('names WHERE, the signed-in note and the fresh fingerprint in details', () => {
    const v = buildUnlockView('https://admin.example.nz', 'Te Rūnanga o Example', 'u_2d7', 'EHa4', '14:06', 'b13e·5c08');
    expect(v.panelName).toBe("Te Rūnanga o Example's control panel");
    expect(v.panelAddress).toBe('admin.example.nz');
    expect(v.signedInNote).toBe('You signed in on this computer at 14:06. This only unlocks steward actions.');
    expect(v.details.aid).toBe('EHa4');
    expect(v.details.challengeId).toBe('u_2d7');
    expect(v.details.sealingKeyFingerprint).toBe('b13e·5c08');
  });

  it('degrades the signed-in note to a timeless sentence when no time rode the code', () => {
    const v = buildUnlockView('https://admin.example.nz', '', 'u_2d7', 'EHa4', '', 'b13e·5c08');
    expect(v.community).toBe('your community');
    expect(v.signedInNote).toBe("You're already signed in on this computer. This only unlocks steward actions.");
  });
});

const ask: UnlockAsk = {
  panel: 'https://admin.example.nz',
  present: RELAY,
  challenge: 'u_2d7',
  sealingKey: 'DFRESHKEY',
  community: 'Te Rūnanga o Example',
  signedInAt: '14:06',
  expiresAt: null,
};

const UNLOCK_LINK =
  'matou://unlock?panel=https://admin.example.nz&present=' +
  encodeURIComponent(RELAY) +
  '&u=u_2d7&ek=DFRESHKEY&name=Home&t=14:06';

function deps(overrides: Partial<UnlockDeps> = {}): UnlockDeps {
  return {
    sealingKeyFingerprint: async (verkey) => `fp(${verkey})`,
    sealPasscode: async (verkey) => `sealed(${verkey})`,
    post: async () => ({ outcome: 'verified' }) as PresentVerdict,
    ready: async () => undefined,
    now: () => 1_000_000,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('useUnlock', () => {
  it('prepareFromLink builds the unlock-only card with the fresh fingerprint', async () => {
    const u = useUnlock(deps());
    const ok = await u.prepareFromLink(UNLOCK_LINK);
    expect(ok).toBe(true);
    expect(u.phase.value).toBe('card');
    expect(u.view.value?.panelName).toBe("Home's control panel");
    expect(u.view.value?.details.sealingKeyFingerprint).toBe('fp(DFRESHKEY)');
  });

  it('prepareFromLink returns false for a non-unlock link (a sign-in code)', async () => {
    const u = useUnlock(deps());
    expect(
      await u.prepareFromLink(
        'matou://signin?door=https://d.nz&present=https://d.nz/p&c=n1&s=EA&ek=DK',
      ),
    ).toBe(false);
  });

  it('unlock seals the passcode to the fresh key and posts it once, then done', async () => {
    const post = vi.fn(async () => ({ outcome: 'verified' }) as PresentVerdict);
    const sealPasscode = vi.fn(async (verkey: string) => `sealed(${verkey})`);
    const u = useUnlock(deps({ post, sealPasscode }));
    await u.prepare(ask);
    await u.unlock();
    expect(sealPasscode).toHaveBeenCalledWith('DFRESHKEY');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(RELAY, { challenge_id: 'u_2d7', sealed_passcode: 'sealed(DFRESHKEY)' });
    expect(u.phase.value).toBe('done');
  });

  it('a refused post lands on refused with the door copy, and posts nothing more', async () => {
    const post = vi.fn(async () => ({ outcome: 'refused', refusal: 'signature' }) as PresentVerdict);
    const u = useUnlock(deps({ post }));
    await u.prepare(ask);
    await u.unlock();
    expect(u.phase.value).toBe('refused');
    expect(u.refusal.value?.kind).toBe('signature');
  });

  it('notNow seals and posts nothing', async () => {
    const post = vi.fn(async () => ({ outcome: 'verified' }) as PresentVerdict);
    const sealPasscode = vi.fn(async () => 'sealed');
    const u = useUnlock(deps({ post, sealPasscode }));
    await u.prepare(ask);
    u.notNow();
    expect(sealPasscode).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses cleanly at read time when the challenge already expired — nothing sealed', async () => {
    const post = vi.fn(async () => ({ outcome: 'verified' }) as PresentVerdict);
    const sealPasscode = vi.fn(async () => 'sealed');
    const u = useUnlock(deps({ post, sealPasscode, now: () => 5_000_000 }));
    await u.prepare({ ...ask, expiresAt: 4_000_000 });
    expect(u.phase.value).toBe('expired');
    // Even if Unlock were somehow invoked, the expired face offers no such button;
    // and prepare never sealed or posted to the dead challenge.
    expect(sealPasscode).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('a fresh challenge (exp in the future) still opens the card', async () => {
    const u = useUnlock(deps({ now: () => 1_000_000 }));
    await u.prepare({ ...ask, expiresAt: 2_000_000 });
    expect(u.phase.value).toBe('card');
  });

  it('falls to the wallet-only unreachable line when there is no passcode to seal', async () => {
    const post = vi.fn(async () => ({ outcome: 'verified' }) as PresentVerdict);
    const u = useUnlock(deps({ post, sealPasscode: async () => null }));
    await u.prepare(ask);
    await u.unlock();
    expect(post).not.toHaveBeenCalled();
    expect(u.phase.value).toBe('refused');
    expect(u.refusal.value?.kind).toBe('site-unreachable');
  });
});
