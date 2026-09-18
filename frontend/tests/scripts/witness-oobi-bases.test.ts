import { describe, it, expect } from 'vitest';
import { witnessOobiBases } from 'src/lib/keri/witnessAssignment';

const IURLS = [
  'http://witness-demo:5642/oobi/BAAA/controller',
  'http://witness-demo:5643/oobi/BBBB/controller',
  'http://witness-demo:5644/oobi/BCCC/controller',
  'http://witness-demo:5645/oobi/BDDD/controller',
  'http://schema-server:7723/oobi/ESCHEMA',
];

describe('witnessOobiBases', () => {
  it('keeps only the bases of the AID\'s own backers', () => {
    expect(witnessOobiBases(IURLS, ['BBBB', 'BDDD'])).toEqual([
      'http://witness-demo:5643',
      'http://witness-demo:5645',
    ]);
  });

  it('falls back to every witness base when the backers are unknown', () => {
    const all = ['http://witness-demo:5642', 'http://witness-demo:5643', 'http://witness-demo:5644', 'http://witness-demo:5645'];
    expect(witnessOobiBases(IURLS)).toEqual(all);
    expect(witnessOobiBases(IURLS, [])).toEqual(all);
  });

  it('falls back to every witness base when no backer is in the config', () => {
    expect(witnessOobiBases(IURLS, ['BZZZ'])).toHaveLength(4);
  });

  it('never returns a non-witness (schema/data) OOBI base', () => {
    expect(witnessOobiBases(IURLS)).not.toContain('http://schema-server:7723');
  });

  it('dedupes witnesses that share a base', () => {
    expect(witnessOobiBases([
      'http://w:5642/oobi/BAAA/controller',
      'http://w:5642/oobi/BAAA/witness',
    ], ['BAAA'])).toEqual(['http://w:5642']);
  });
});
