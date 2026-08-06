import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('src/lib/clientConfig', () => ({
  fetchClientConfig: vi.fn(),
}));

import { assignWitnesses } from 'src/lib/keri/witnessAssignment';
import { fetchClientConfig } from 'src/lib/clientConfig';

const mockConfig = (aids: Record<string, string>) => {
  (fetchClientConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
    witnesses: { urls: [], aids, oobis: [] },
  });
};

describe('assignWitnesses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('splits a 6-witness pool into disjoint halves with toad=2', async () => {
    mockConfig({
      wit0: 'BAAA', wit1: 'BBBB', wit2: 'BCCC',
      wit3: 'BDDD', wit4: 'BEEE', wit5: 'BFFF',
    });
    const out = await assignWitnesses();
    expect(out.personal).toEqual(['BAAA', 'BBBB', 'BCCC']);
    expect(out.org).toEqual(['BDDD', 'BEEE', 'BFFF']);
    expect(out.toad).toBe(2);
    expect(new Set([...out.personal, ...out.org]).size).toBe(6);
  });

  it('splits a 4-witness pool with toad=2', async () => {
    mockConfig({ a: 'BAAA', b: 'BBBB', c: 'BCCC', d: 'BDDD' });
    const out = await assignWitnesses();
    expect(out.personal).toEqual(['BAAA', 'BBBB']);
    expect(out.org).toEqual(['BCCC', 'BDDD']);
    expect(out.toad).toBe(2);
  });

  it('drops to toad=1 for a 3-witness pool', async () => {
    mockConfig({ a: 'BAAA', b: 'BBBB', c: 'BCCC' });
    const out = await assignWitnesses();
    expect(out.personal).toEqual(['BAAA']);
    expect(out.org).toEqual(['BBBB', 'BCCC']);
    expect(out.toad).toBe(1);
  });

  it('throws on a pool of < 2 witnesses', async () => {
    mockConfig({ a: 'BAAA' });
    await expect(assignWitnesses()).rejects.toThrow(/at least 2/i);
  });

  it('is deterministic regardless of map iteration order', async () => {
    mockConfig({ wit3: 'BDDD', wit1: 'BBBB', wit0: 'BAAA', wit2: 'BCCC' });
    const a = await assignWitnesses();
    mockConfig({ wit2: 'BCCC', wit0: 'BAAA', wit1: 'BBBB', wit3: 'BDDD' });
    const b = await assignWitnesses();
    expect(a).toEqual(b);
  });
});

describe('extractWitnessAids', () => {
  it('extracts witness AIDs from iurls and drops schema/data OOBIs', async () => {
    const { extractWitnessAids } = await import('src/lib/keri/witnessAssignment');
    const iurls = [
      'http://witness-demo:5642/oobi/BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha/controller',
      'http://witness-demo:5643/oobi/BLskRTInXnMxWaGqcpSyMgo0nYbalW99cGZESrz3zapM/controller',
      // schema OOBIs also appear in iurls (infra 2c010fb) — SAIDs, not witnesses
      'http://schema-server:7723/oobi/EIefouRuIuoi9ZtnW3BOCSVeXQSt8k3uJLvmYHfvNPOE',
      'http://schema-server:7723/oobi/ELhtmIAF5uZp40VJ08P7LJ_A4JH53ybWdvkSA3L-Sw2J',
    ];
    expect(extractWitnessAids(iurls)).toEqual([
      'BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha',
      'BLskRTInXnMxWaGqcpSyMgo0nYbalW99cGZESrz3zapM',
    ]);
  });

  it('ignores URLs without an /oobi/ path', async () => {
    const { extractWitnessAids } = await import('src/lib/keri/witnessAssignment');
    expect(extractWitnessAids(['http://example.com/health', ''])).toEqual([]);
  });
});
