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

import { useSignin, type SigninDeps } from 'src/composables/useSignin';
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
    ...overrides,
  };
}

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
