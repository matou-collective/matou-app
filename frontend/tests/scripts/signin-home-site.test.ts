/**
 * The home sign-in site is pre-trusted, so a community's own QR never raises the
 * first-contact prompt (idss #1492 story 12, #574 acceptance §4). The golden's
 * one-string rule: the descriptor's `signin.url` == the ask's `door` == the
 * address the bridge's verifier binds. When those are byte-for-byte equal, the
 * home-seeded `knownDoors` entry pre-trusts exactly the door the link names, so
 * `useSignin` goes straight to the approve card.
 *
 * This drives the REAL knownDoors store (only secureStorage is faked) alongside
 * useSignin, so the home-site → card path is proven end to end, not mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import golden from './fixtures/app-door/app-door-golden.json';

// In-memory secureStorage so the real knownDoors store persists without a browser.
const mem = new Map<string, string>();
vi.mock('src/lib/secureStorage', () => ({
  secureStorage: {
    getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => void mem.set(k, v)),
    removeItem: vi.fn(async (k: string) => void mem.delete(k)),
  },
}));

vi.mock('src/lib/keri/client', () => ({
  useKERIClient: () => ({ getSignifyClient: () => null, ensureSession: async () => undefined }),
}));
vi.mock('src/lib/clientConfig', () => ({ getCommunityDescriptor: async () => ({ schemas: {} }) }));
vi.mock('stores/identity', () => ({ useIdentityStore: () => ({ aidPrefix: 'EHa' }) }));

import { useSignin, type SigninDeps } from 'src/composables/useSignin';
import { useKnownDoorsStore } from 'src/stores/knownDoors';
import type { HeldCredential } from 'src/lib/signin/credential';

// The golden's one string: signin.url == door.
const SIGNIN_URL = golden.sign_in_site.value;
const PRESENT_URL = golden.ask.response.present_url;

const cred: HeldCredential = {
  sad: { d: 'ECred', s: 'EMe', a: { i: 'EHa', role: 'Member', dt: '2026-08-12T00:00:00Z' } },
};

function link(door: string): string {
  const q = new URLSearchParams({ door, present: PRESENT_URL, c: 'nonce-EXAMPLE', s: 'EMe', name: 'Whakatōhea' });
  return 'matou://signin?' + q.toString();
}

function deps(): SigninDeps {
  return {
    listCredentials: async () => [cred],
    exportCredential: async (said) => `EXPORT:${said}`,
    sign: async (_aid, m) => `sig(${m})`,
    present: async () => ({ outcome: 'verified' }),
    schemaKinds: async () => ({ EMe: 'membership' }),
  };
}

describe('home sign-in site (#574 §4)', () => {
  beforeEach(() => {
    mem.clear();
    setActivePinia(createPinia());
  });

  it('a link whose door equals the descriptor signin.url goes straight to the approve card', async () => {
    // The page seeds the home site from descriptor.signin.url on mount.
    const known = useKnownDoorsStore();
    await known.seedHome(SIGNIN_URL, 'Whakatōhea');

    const s = useSignin(deps());
    await s.prepareFromLink(link(SIGNIN_URL));

    // No first-contact prompt for the community's own QR — straight to the card,
    // marked as the home site.
    expect(s.phase.value).toBe('card');
    expect(s.view.value?.isHome).toBe(true);
  });

  it('a link naming a site the wallet has never met still stops at first-contact', async () => {
    const known = useKnownDoorsStore();
    await known.seedHome(SIGNIN_URL, 'Whakatōhea');

    const s = useSignin(deps());
    await s.prepareFromLink(link('https://id.other.example.nz/login'));

    expect(s.phase.value).toBe('first-contact');
    expect(s.view.value?.isHome).toBe(false);
  });
});
