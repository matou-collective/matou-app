import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseCredentialDisplay,
  titleCaseCommittee,
  credentialTitle,
  pascalFromKebab,
  resolveLucideIcon,
  relativeLuminance,
  pickInk,
  normalizeDigest,
  sha256Hex,
  loadVerifiedImage,
} from '../../src/lib/credentialAppearance';

describe('parseCredentialDisplay', () => {
  it('returns undefined for absent / malformed blocks', () => {
    expect(parseCredentialDisplay(undefined)).toBeUndefined();
    expect(parseCredentialDisplay(null)).toBeUndefined();
    expect(parseCredentialDisplay('nope')).toBeUndefined();
    expect(parseCredentialDisplay({})).toBeUndefined();
    expect(parseCredentialDisplay({ name: '' })).toBeUndefined();
    expect(parseCredentialDisplay({ name: '   ' })).toBeUndefined();
  });

  it('keeps a name and a well-formed icon + background', () => {
    const d = parseCredentialDisplay({
      name: 'Finance komiti',
      icon: 'landmark',
      background: '#0A5C6B',
    });
    expect(d).toEqual({ name: 'Finance komiti', icon: 'landmark', background: '#0A5C6B' });
  });

  it('drops a malformed background but keeps the rest', () => {
    const d = parseCredentialDisplay({ name: 'X', background: 'teal' });
    expect(d).toEqual({ name: 'X' });
  });

  it('keeps a fully-specified image and drops a half-specified one', () => {
    expect(parseCredentialDisplay({ name: 'X', image: { url: 'u', digest: 'd' } })).toEqual({
      name: 'X',
      image: { url: 'u', digest: 'd' },
    });
    expect(parseCredentialDisplay({ name: 'X', image: { url: 'u' } })).toEqual({ name: 'X' });
    expect(parseCredentialDisplay({ name: 'X', image: { digest: 'd' } })).toEqual({ name: 'X' });
  });
});

describe('titleCaseCommittee / credentialTitle', () => {
  it('title-cases committee slugs', () => {
    expect(titleCaseCommittee('finance')).toBe('Finance');
    expect(titleCaseCommittee('finance-komiti')).toBe('Finance Komiti');
    expect(titleCaseCommittee('te_reo panel')).toBe('Te Reo Panel');
  });

  it('prefers display.name, then committee, then the legacy fallback', () => {
    expect(credentialTitle({ display: { name: 'Kaitiaki' }, committee: 'finance' }, 'Legacy')).toBe(
      'Kaitiaki',
    );
    expect(credentialTitle({ committee: 'finance-komiti' }, 'Legacy')).toBe('Finance Komiti');
    expect(credentialTitle({}, 'Legacy')).toBe('Legacy');
  });
});

describe('pascalFromKebab / resolveLucideIcon', () => {
  it('converts kebab keys to PascalCase', () => {
    expect(pascalFromKebab('landmark')).toBe('Landmark');
    expect(pascalFromKebab('a-arrow-down')).toBe('AArrowDown');
    expect(pascalFromKebab('building-2')).toBe('Building2');
  });

  it('resolves a valid Lucide key to a component and null for unknown/base', async () => {
    expect(await resolveLucideIcon('landmark')).toBeTruthy();
    expect(await resolveLucideIcon('shield-check')).toBeTruthy();
    expect(await resolveLucideIcon('definitely-not-a-real-icon')).toBeNull();
    expect(await resolveLucideIcon('icon')).toBeNull();
    expect(await resolveLucideIcon(undefined)).toBeNull();
  });
});

describe('relativeLuminance / pickInk (IDSS lum > 0.4 → dark ink)', () => {
  it('white is luminous, black is not', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
  });

  it('picks dark ink on light backgrounds and light ink on dark ones', () => {
    expect(pickInk('#ffffff')).toBe('#1f2937');
    expect(pickInk('#000000')).toBe('#ffffff');
    // Deep teal — a dark background → light ink.
    expect(pickInk('#0a5c6b')).toBe('#ffffff');
  });
});

describe('normalizeDigest / sha256Hex', () => {
  it('normalises prefixes and case', () => {
    expect(normalizeDigest('SHA256:ABCD')).toBe('abcd');
    expect(normalizeDigest('sha256-ABCD')).toBe('abcd');
    expect(normalizeDigest('  ABCD  ')).toBe('abcd');
  });

  it('computes a known sha256', async () => {
    const bytes = new TextEncoder().encode('hello').buffer;
    // sha256("hello")
    expect(await sha256Hex(bytes)).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('loadVerifiedImage', () => {
  const bytes = new TextEncoder().encode('PNGDATA-unique-1');
  let digest: string;

  beforeEach(async () => {
    digest = await sha256Hex(bytes.buffer);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeResponse(body: Uint8Array, ok = true) {
    return {
      ok,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => body.buffer.slice(0),
    } as unknown as Response;
  }

  it('returns a data URL when the digest matches', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(bytes));
    const url = await loadVerifiedImage({ url: 'http://x/img.png', digest });
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it('returns null (falls back to the seal) on a digest mismatch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(bytes));
    const url = await loadVerifiedImage({
      url: 'http://x/other.png',
      digest: 'f'.repeat(64),
    });
    expect(url).toBeNull();
  });

  it('serves from cache without re-fetching — works offline after first sight', async () => {
    const other = new TextEncoder().encode('PNGDATA-unique-2');
    const otherDigest = await sha256Hex(other.buffer);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(other));

    const first = await loadVerifiedImage({ url: 'http://x/2.png', digest: otherDigest });
    expect(first).toMatch(/^data:image\/png;base64,/);
    expect(spy).toHaveBeenCalledTimes(1);

    // Now go "offline": fetch throws. The cached image must still resolve.
    spy.mockRejectedValue(new Error('offline'));
    const second = await loadVerifiedImage({ url: 'http://x/2.png', digest: otherDigest });
    expect(second).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns null when the fetch fails and nothing is cached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    const url = await loadVerifiedImage({ url: 'http://x/miss.png', digest: 'a'.repeat(64) });
    expect(url).toBeNull();
  });
});
