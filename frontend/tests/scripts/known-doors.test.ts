/**
 * The known sign-in sites store (idss #1492 stories 12/13/17). The home site is
 * seeded from the descriptor and marked as home; a completed sign-in touches
 * only that door's lastUsed and nothing else is remembered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// In-memory secureStorage so the store persists without a browser.
const mem = new Map<string, string>();
vi.mock('src/lib/secureStorage', () => ({
  secureStorage: {
    getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => void mem.set(k, v)),
    removeItem: vi.fn(async (k: string) => void mem.delete(k)),
  },
}));

import { useKnownDoorsStore } from 'src/stores/knownDoors';

describe('knownDoors store', () => {
  beforeEach(() => {
    mem.clear();
    setActivePinia(createPinia());
  });

  it('seeds the home site and marks it home, ignoring a trailing slash', async () => {
    const store = useKnownDoorsStore();
    await store.seedHome('https://id.example.nz/', 'Te Rūnanga o Example');

    expect(store.isHome('https://id.example.nz')).toBe(true);
    expect(store.isKnown('https://id.example.nz/')).toBe(true);
    expect(store.get('https://id.example.nz')?.name).toBe('Te Rūnanga o Example');
    // a site never met is neither home nor known
    expect(store.isHome('https://other.nz')).toBe(false);
    expect(store.isKnown('https://other.nz')).toBe(false);
  });

  it('re-seeding refreshes the name but keeps firstMet', async () => {
    const store = useKnownDoorsStore();
    await store.seedHome('https://id.example.nz', 'Old Name');
    const firstMet = store.get('https://id.example.nz')!.firstMet;
    await store.seedHome('https://id.example.nz', 'New Name');
    expect(store.get('https://id.example.nz')!.name).toBe('New Name');
    expect(store.get('https://id.example.nz')!.firstMet).toBe(firstMet);
  });

  it('touch updates only lastUsed on a known door and no-ops an unknown one', async () => {
    const store = useKnownDoorsStore();
    await store.seedHome('https://id.example.nz', 'Home');
    const before = store.get('https://id.example.nz')!;
    await new Promise((r) => setTimeout(r, 5));
    await store.touch('https://id.example.nz');
    const after = store.get('https://id.example.nz')!;
    expect(after.firstMet).toBe(before.firstMet);
    expect(new Date(after.lastUsed).getTime()).toBeGreaterThanOrEqual(new Date(before.lastUsed).getTime());

    // an unknown door is not silently created (first-contact is another ticket)
    await store.touch('https://unknown.nz');
    expect(store.isKnown('https://unknown.nz')).toBe(false);
  });

  it('persists across store instances', async () => {
    const a = useKnownDoorsStore();
    await a.seedHome('https://id.example.nz', 'Home');
    setActivePinia(createPinia());
    const b = useKnownDoorsStore();
    await b.load();
    expect(b.isHome('https://id.example.nz')).toBe(true);
  });
});
