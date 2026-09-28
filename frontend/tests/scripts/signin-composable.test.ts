/**
 * useSignin phase machine (idss #1492 stories 13–17/28, WS-A2/A2p/A2d/A2r).
 * Prepare builds the card; Approve drives proving → done (touching the known
 * door) or → refused with the matching copy; Not now signs and posts nothing.
 *
 * The heavy KERI/descriptor/store modules are mocked so only the controller's
 * logic runs; side-effects come in through injected deps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const touch = vi.fn(async () => undefined);
const trust = vi.fn(async () => undefined);
const knownDoors = {
  load: vi.fn(async () => undefined),
  isHome: vi.fn(() => true),
  isKnown: vi.fn(() => true),
  trust,
  touch,
};

vi.mock('src/lib/keri/client', () => ({
  useKERIClient: () => ({ getSignifyClient: () => null, ensureSession: async () => undefined }),
}));
vi.mock('src/lib/clientConfig', () => ({ getCommunityDescriptor: async () => ({ schemas: {} }) }));
vi.mock('stores/identity', () => ({ useIdentityStore: () => ({ aidPrefix: 'EHa' }) }));
vi.mock('src/stores/knownDoors', () => ({ useKnownDoorsStore: () => knownDoors }));

import { useSignin, walletReady, type SigninDeps } from 'src/composables/useSignin';
import { reactive } from 'vue';
import type { HeldCredential } from 'src/lib/signin/credential';

const cred: HeldCredential = {
  sad: { d: 'ECred', s: 'EMe', a: { i: 'EHa', role: 'Member', dt: '2026-08-12T00:00:00Z' } },
};

const LINK =
  'matou://signin?door=https://id.example.nz/login&present=https://id.example.nz/login/app/present&c=c_3f9&s=EMe&name=Home&service=Files';

function deps(overrides: Partial<SigninDeps> = {}): SigninDeps {
  return {
    listCredentials: async () => [cred],
    exportCredential: async (said) => `EXPORT:${said}`,
    sign: async (_aid, m) => `sig(${m})`,
    present: async () => ({ outcome: 'verified' }),
    schemaKinds: async () => ({ EMe: 'membership' }),
    ready: async () => undefined,
    sealingKeyFingerprint: async (verkey) => `fp(${verkey})`,
    now: () => 1_000_000,
    arm: () => undefined,
    ...overrides,
  };
}

// A steward's control-panel sign-in: the link carries `ek=` (a sealing key) and
// the held credential's role is operator. #663.
const stewardCred: HeldCredential = {
  sad: { d: 'ECred', s: 'EMe', i: 'ECommunity', a: { i: 'EHa', role: 'operator', dt: '2026-08-12T00:00:00Z' } },
};
const PANEL_LINK =
  'matou://signin?door=https://id.example.nz/login&present=https://id.example.nz/login/app/present&c=c_panel&s=EMe&name=Home&svc=the%20control%20panel&ek=DVERKEY_EXAMPLE';

beforeEach(() => {
  vi.clearAllMocks();
  knownDoors.isHome.mockReturnValue(true);
  knownDoors.isKnown.mockReturnValue(true);
});

describe('useSignin', () => {
  it('prepareFromLink builds the card view and finds the credential', async () => {
    const s = useSignin(deps());
    const ok = await s.prepareFromLink(LINK);
    expect(ok).toBe(true);
    expect(s.phase.value).toBe('card');
    expect(s.view.value?.service).toBe('Files');
    expect(s.view.value?.isHome).toBe(true);
    expect(s.view.value?.credential?.kindLabel).toBe('Membership');
    expect(s.chosen.value).toBe(cred);
  });

  it('prepareFromLink returns false for a non-signin link', async () => {
    const s = useSignin(deps());
    expect(await s.prepareFromLink('matou://pair?id=x&pk=y&s=z')).toBe(false);
  });

  it('approve → proving → done touches the known door', async () => {
    const s = useSignin(deps());
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.phase.value).toBe('done');
    expect(touch).toHaveBeenCalledWith('https://id.example.nz/login');
  });

  it('approve → refused renders the matching refusal copy', async () => {
    const s = useSignin(deps({ present: async () => ({ outcome: 'refused', refusal: 'revoked' }) }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.phase.value).toBe('refused');
    expect(s.refusal.value?.kind).toBe('revoked');
    expect(s.refusal.value?.text).toContain('has been revoked');
    expect(touch).not.toHaveBeenCalled();
  });

  it('a post that gets no answer shows the wallet-only site-unreachable line', async () => {
    const s = useSignin(deps({ present: async () => ({ outcome: 'site-unreachable' }) }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.refusal.value?.kind).toBe('site-unreachable');
    expect(s.refusal.value?.showContact).toBe(false);
  });

  it('a wallet-side failure during approve is shown as site-unreachable', async () => {
    const s = useSignin(deps({ sign: async () => { throw new Error('no signer'); } }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(s.phase.value).toBe('refused');
    expect(s.refusal.value?.kind).toBe('site-unreachable');
  });

  it('a known (or home) site skips straight to the card, no first-contact', async () => {
    knownDoors.isKnown.mockReturnValue(true);
    const s = useSignin(deps());
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('card');
  });

  it('an unmet site stops at the first-contact prompt before any card (#535)', async () => {
    knownDoors.isKnown.mockReturnValue(false);
    const s = useSignin(deps());
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('first-contact');
    // The card view is still built so Trust can continue to it, and it carries
    // the address the prompt shows.
    expect(s.view.value?.siteAddress).toBe('id.example.nz');
  });

  it('trust adds the site and continues to the approve card (#535)', async () => {
    knownDoors.isKnown.mockReturnValue(false);
    const s = useSignin(deps());
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('first-contact');
    await s.trust();
    expect(trust).toHaveBeenCalledWith('https://id.example.nz/login', 'Home');
    expect(s.phase.value).toBe('card');
  });

  it('notNow signs and posts nothing', async () => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const s = useSignin(deps({ present }));
    await s.prepareFromLink(LINK);
    s.notNow();
    expect(present).not.toHaveBeenCalled();
    expect(s.phase.value).toBe('card');
  });
});

// A sign-in code opened before the wallet has finished restoring its session
// (a cold start from the camera: session restore runs non-blocking in boot)
// used to leave the card blank with a disabled Approve until a second scan.
describe('useSignin — preparing before the wallet is ready', () => {
  it('starts on loading, waits for the wallet, and only then reads credentials', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const listCredentials = vi.fn(async () => [cred]);
    const s = useSignin(deps({ ready: () => gate, listCredentials }));
    expect(s.phase.value).toBe('loading');
    const pending = s.prepareFromLink(LINK);
    await Promise.resolve();
    expect(s.phase.value).toBe('loading');
    expect(s.view.value).toBeNull();
    expect(listCredentials).not.toHaveBeenCalled();
    release();
    await pending;
    expect(s.phase.value).toBe('card');
    expect(s.view.value?.service).toBe('Files');
  });

  it('lands on unavailable, never a half-built card, when the wallet never gets ready', async () => {
    const s = useSignin(deps({ ready: async () => { throw new Error('wallet not ready'); } }));
    await expect(s.prepareFromLink(LINK)).resolves.toBe(true);
    expect(s.phase.value).toBe('unavailable');
    expect(s.view.value).toBeNull();
  });

  it('lands on unavailable when reading the credentials fails', async () => {
    const s = useSignin(deps({ listCredentials: async () => { throw new Error('agent not connected'); } }));
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('unavailable');
    expect(s.view.value).toBeNull();
  });

  it('retry re-runs the same sign-in and reaches the card once the wallet answers', async () => {
    let fail = true;
    const s = useSignin(deps({ listCredentials: async () => { if (fail) throw new Error('not yet'); return [cred]; } }));
    await s.prepareFromLink(LINK);
    expect(s.phase.value).toBe('unavailable');
    fail = false;
    await s.retry();
    expect(s.phase.value).toBe('card');
    expect(s.chosen.value).toBe(cred);
  });
});

describe('walletReady — the default readiness gate', () => {
  it('waits for the session restore to finish, then refreshes the agent session', async () => {
    const identity = reactive({ isReady: false, aidPrefix: null as string | null });
    const ensureSession = vi.fn(async () => undefined);
    let settled = false;
    const p = walletReady(identity, { ensureSession }).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    identity.aidPrefix = 'EHa';
    identity.isReady = true;
    await p;
    expect(ensureSession).toHaveBeenCalledTimes(1);
  });

  it('fails when the restore finishes with no identity', async () => {
    const identity = reactive({ isReady: true, aidPrefix: null as string | null });
    await expect(walletReady(identity, { ensureSession: async () => undefined })).rejects.toThrow(/no identity/);
  });

  it('gives up after the timeout', async () => {
    const identity = reactive({ isReady: false, aidPrefix: null as string | null });
    await expect(walletReady(identity, { ensureSession: async () => undefined }, 10)).rejects.toThrow(/did not finish/);
  });
});

// The steward-unlock line and the passcode sealed to the panel's key (#663,
// PU-A2u). The line appears ONLY for a steward's control-panel sign-in; on
// approve with it on the passcode is sealed and posted once; every other card is
// untouched and nothing is armed.
describe('useSignin — the steward-unlock line (#663)', () => {
  it('offers the unlock line, on by default, for a steward control-panel sign-in', async () => {
    const s = useSignin(deps({ listCredentials: async () => [stewardCred] }));
    await s.prepareFromLink(PANEL_LINK);
    expect(s.phase.value).toBe('card');
    expect(s.unlockAvailable.value).toBe(true);
    expect(s.unlockOn.value).toBe(true);
    // The sealing-key fingerprint rides the details, off the face.
    expect(s.view.value?.unlock).toEqual({ sealingKeyFingerprint: 'fp(DVERKEY_EXAMPLE)' });
  });

  it('offers no unlock line for an ordinary service sign-in (no ek)', async () => {
    const s = useSignin(deps({ listCredentials: async () => [stewardCred] }));
    await s.prepareFromLink(LINK);
    expect(s.unlockAvailable.value).toBe(false);
    expect(s.view.value?.unlock).toBeNull();
  });

  it('offers no unlock line to a non-steward on a control-panel sign-in', async () => {
    // The held credential is a plain Member (role !== operator).
    const s = useSignin(deps({ listCredentials: async () => [cred] }));
    await s.prepareFromLink(PANEL_LINK);
    expect(s.unlockAvailable.value).toBe(false);
    expect(s.view.value?.unlock).toBeNull();
  });

  it('arms for the challenge and posts no sealed_passcode when the line is on (#674)', async () => {
    // Approve now ARMS the wallet for the panel's later request rather than
    // sealing to the sign-in code's `ek=`; the present request carries no
    // passcode, and the box the panel can open is minted only when it asks.
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const arm = vi.fn((_challenge: string, _expiresAt: number) => undefined);
    const s = useSignin(deps({ listCredentials: async () => [stewardCred], present, arm, now: () => 1_000_000 }));
    await s.prepareFromLink(PANEL_LINK);
    await s.approve();
    expect(arm).toHaveBeenCalledTimes(1);
    // Armed for the sign-in's own challenge, with an expiry in the future.
    expect(arm.mock.calls[0]![0]).toBe('c_panel');
    expect(arm.mock.calls[0]![1]).toBeGreaterThan(1_000_000);
    expect(present).toHaveBeenCalledTimes(1);
    expect(present.mock.calls[0]![1]).not.toHaveProperty('sealed_passcode');
    expect(s.phase.value).toBe('done');
  });

  it('arms nothing and posts no sealed_passcode when the line is switched off (#674)', async () => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const arm = vi.fn((_challenge: string, _expiresAt: number) => undefined);
    const s = useSignin(deps({ listCredentials: async () => [stewardCred], present, arm }));
    await s.prepareFromLink(PANEL_LINK);
    s.setUnlock(false);
    await s.approve();
    expect(arm).not.toHaveBeenCalled();
    expect(present.mock.calls[0]![1]).not.toHaveProperty('sealed_passcode');
    expect(s.phase.value).toBe('done');
  });

  it('arms nothing on an ordinary service sign-in even for a steward (#674)', async () => {
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const arm = vi.fn((_challenge: string, _expiresAt: number) => undefined);
    const s = useSignin(deps({ listCredentials: async () => [stewardCred], present, arm }));
    await s.prepareFromLink(LINK);
    await s.approve();
    expect(arm).not.toHaveBeenCalled();
    expect(present.mock.calls[0]![1]).not.toHaveProperty('sealed_passcode');
  });

  it('signs in with the seat locked when arming throws (#674)', async () => {
    // A failure to arm must never block the sign-in — it degrades to an ordinary
    // locked-seat session; nothing but a later ciphertext ever leaves.
    const present = vi.fn(async () => ({ outcome: 'verified' as const }));
    const arm = vi.fn(() => {
      throw new Error('no passcode in this session');
    });
    const s = useSignin(deps({ listCredentials: async () => [stewardCred], present, arm }));
    await s.prepareFromLink(PANEL_LINK);
    await s.approve();
    expect(present.mock.calls[0]![1]).not.toHaveProperty('sealed_passcode');
    expect(s.phase.value).toBe('done');
  });
});
