import { describe, it, expect } from 'vitest';
import { indexedSigs, sigIndex, mergeSigs, telBundle } from 'src/lib/keri/steward/sigs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const sig = (idx: number, fill: string) => `A${B64[idx]}` + fill.repeat(86);
function ev(obj: Record<string, unknown>, proto = 'KERI'): string {
  const body = JSON.stringify({ v: `${proto}10JSON000000_`, ...obj });
  const size = new TextEncoder().encode(body).length;
  return body.replace('000000', size.toString(16).padStart(6, '0'));
}

describe('indexedSigs', () => {
  it('reads a bare -A group', () => {
    const atc = `-AAC${sig(0, 'x')}${sig(1, 'y')}`;
    expect(indexedSigs(atc)).toEqual([sig(0, 'x'), sig(1, 'y')]);
  });
  it('unwraps a -V## attachment group', () => {
    expect(indexedSigs(`-VAX-AAB${sig(1, 'z')}`)).toEqual([sig(1, 'z')]);
  });
  it('throws on an attachment without signatures', () => {
    expect(() => indexedSigs('-BAC')).toThrow(/indexed signature/);
  });
});

describe('mergeSigs', () => {
  it('dedupes by index and sorts by index, first wins', () => {
    expect(mergeSigs([sig(1, 'a')], [sig(0, 'b'), sig(1, 'c')])).toEqual([sig(0, 'b'), sig(1, 'a')]);
    expect(sigIndex(sig(1, 'a'))).toBe(1);
  });
});

describe('telBundle', () => {
  it('picks the ACDC, its iss/rev and each one\'s anchoring ixn', () => {
    const acdc = ev({ d: 'ECRED', i: 'EGRP', ri: 'EREG', s: 'ESCH', a: { i: 'EHOLDER', dt: '2026-09-30T00:00:00.000000+00:00' } }, 'ACDC');
    const iss = ev({ t: 'iss', d: 'EISS', i: 'ECRED', s: '0', ri: 'EREG', dt: 'x' });
    const ancIss = ev({ t: 'ixn', d: 'EANC1', i: 'EGRP', s: '4', p: 'E', a: [{ i: 'ECRED', s: '0', d: 'EISS' }] });
    const rev = ev({ t: 'rev', d: 'EREV', i: 'ECRED', s: '1', ri: 'EREG', p: 'EISS', dt: 'y' });
    const ancRev = ev({ t: 'ixn', d: 'EANC2', i: 'EGRP', s: '5', p: 'E', a: [{ i: 'ECRED', s: '1', d: 'EREV' }] });
    const stream = `${ancIss}-AAB${sig(0, 'q')}${iss}-GAB${acdc}${ancRev}-AAB${sig(1, 'r')}${rev}`;
    const b = telBundle(stream, 'ECRED');
    expect(b.acdc.event.d).toBe('ECRED');
    expect(b.iss?.event.d).toBe('EISS');
    expect(b.issAnc?.event.d).toBe('EANC1');
    expect(indexedSigs(b.issAnc!.attachment)).toEqual([sig(0, 'q')]);
    expect(b.rev?.event.d).toBe('EREV');
    expect(b.revAnc?.event.d).toBe('EANC2');
  });
  it('throws when the ACDC is not in the export', () => {
    expect(() => telBundle('', 'ECRED')).toThrow(/ECRED/);
  });
});
