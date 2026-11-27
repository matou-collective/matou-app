/**
 * The in-memory signer cache (idss #1492 story 18). A second sign-in in the
 * same unlocked session reuses the derived signer; a lock drops it so nothing
 * survives.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getSigner, clearSigners, dropSigner, hasCachedSigner, keyStateOf, setSignerFactory } from 'src/lib/signin/signer';

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

/**
 * A signer is only good for the keys it was resolved at. A steward's own
 * identity rotates its keys whenever the steward set changes (promoting a
 * founding member is a group rotation, and every signer rotates first), and the
 * sign-in door verifies against the NEWEST key state. A signer kept across that
 * rotation signs with the old key, and the door answers `signature` to a
 * steward who did nothing wrong (Whakatōhea Demo, 2026-09-29: the founder
 * signed in, promoted a member, and was refused at the next sign-in until the
 * app was restarted).
 */
describe('signer cache follows the key state', () => {
  it('re-resolves the signer once the identity has rotated its keys', async () => {
    let keys = 'kidx:0';
    const factory = vi.fn(async (aid: string) => {
      const resolvedAt = keys;
      return { sign: async (m: string) => `${aid}@${resolvedAt}:${m}` };
    });
    setSignerFactory(factory, async () => keys);

    const before = await getSigner('EHa');
    await expect(before.sign('msg')).resolves.toBe('EHa@kidx:0:msg');

    keys = 'kidx:1'; // the identity rotated — by this app or by another client of the same agent

    const after = await getSigner('EHa');
    expect(after).not.toBe(before);
    expect(factory).toHaveBeenCalledTimes(2);
    await expect(after.sign('msg')).resolves.toBe('EHa@kidx:1:msg');
  });

  it('keeps the signer while the key state is unchanged', async () => {
    const factory = vi.fn(async (aid: string) => ({ sign: async () => aid }));
    setSignerFactory(factory, async () => 'kidx:4');

    const first = await getSigner('EHa');
    const second = await getSigner('EHa');

    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('keeps the signer it has when the key state cannot be read', async () => {
    const factory = vi.fn(async (aid: string) => ({ sign: async () => aid }));
    let reachable = true;
    setSignerFactory(factory, async () => {
      if (!reachable) throw new Error('agent unreachable');
      return 'kidx:0';
    });

    const first = await getSigner('EHa');
    reachable = false;
    const second = await getSigner('EHa');

    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('dropSigner forgets one identity and leaves the others', async () => {
    const factory = vi.fn(async (aid: string) => ({ sign: async () => aid }));
    setSignerFactory(factory, async () => 'kidx:0');

    await getSigner('EA');
    await getSigner('EB');
    dropSigner('EA');

    expect(hasCachedSigner('EA')).toBe(false);
    expect(hasCachedSigner('EB')).toBe(true);
  });
});

describe('keyStateOf', () => {
  it('changes when a rotation advances the key index', () => {
    const before = keyStateOf({ prefix: 'EHa', salty: { pidx: 0, kidx: 2, sxlt: '1AAH…' } });
    const after = keyStateOf({ prefix: 'EHa', salty: { pidx: 0, kidx: 3, sxlt: '1AAH…' } });
    expect(after).not.toBe(before);
  });

  it('changes when the twelve words are replaced (the salt is re-encrypted)', () => {
    const before = keyStateOf({ prefix: 'EHa', salty: { pidx: 0, kidx: 3, sxlt: '1AAH-old' } });
    const after = keyStateOf({ prefix: 'EHa', salty: { pidx: 0, kidx: 3, sxlt: '1AAH-new' } });
    expect(after).not.toBe(before);
  });

  it('is the same for the same keeper parameters', () => {
    const a = keyStateOf({ prefix: 'EHa', salty: { pidx: 0, kidx: 3, sxlt: 'x' } });
    const b = keyStateOf({ prefix: 'EHa', salty: { pidx: 0, kidx: 3, sxlt: 'x' } });
    expect(a).toBe(b);
  });
});
