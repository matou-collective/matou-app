/**
 * The in-memory signer cache (idss #1492 story 18). A second sign-in in the
 * same unlocked session reuses the derived signer; a lock drops it so nothing
 * survives.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getSigner, clearSigners, hasCachedSigner, setSignerFactory } from 'src/lib/signin/signer';

afterEach(() => {
  setSignerFactory(null); // also clears the cache
});

describe('signer cache', () => {
  it('resolves once and reuses the signer for repeat signs', async () => {
    const factory = vi.fn(async (aid: string) => ({ sign: async (m: string) => `${aid}:${m}` }));
    setSignerFactory(factory);

    const first = await getSigner('EHa');
    const second = await getSigner('EHa');

    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(hasCachedSigner('EHa')).toBe(true);
    await expect(first.sign('msg')).resolves.toBe('EHa:msg');
  });

  it('keeps a distinct signer per AID', async () => {
    setSignerFactory(async (aid: string) => ({ sign: async () => aid }));
    const a = await getSigner('EA');
    const b = await getSigner('EB');
    expect(a).not.toBe(b);
  });

  it('clearSigners drops the cache so the next sign re-resolves', async () => {
    const factory = vi.fn(async (aid: string) => ({ sign: async () => aid }));
    setSignerFactory(factory);

    await getSigner('EHa');
    clearSigners();
    expect(hasCachedSigner('EHa')).toBe(false);

    await getSigner('EHa');
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
