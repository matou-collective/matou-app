import { describe, it, expect, vi } from 'vitest';
import { KERIClient } from 'src/lib/keri/client';

/**
 * Unit coverage for KERIClient.verifyGroupKelWitnessed — the issue #51 guard
 * that refuses to IPEX-grant a group-AID credential until the org's witnesses
 * actually serve the KEL up to the anchoring `iss`/`vcp` ixn (or a member-add
 * rotation). We stub the signify client so no live KERIA/witnesses are needed:
 * the decision logic is what we assert.
 */

const GROUP = 'EGUOrRYy6IssGroupAidPrefix000000000000000000';

interface StubOpts {
  localSn: string;
  // Sequence of key-state sn's the witnesses report on successive queries.
  // 'throw' models keyStates().query timing out (witnesses not serving yet).
  querySn: Array<string | 'throw'>;
}

function makeClient(kc: KERIClient, opts: StubOpts) {
  let queryCall = 0;
  const stub = {
    state: vi.fn().mockResolvedValue({}),
    keyStates: () => ({
      get: vi.fn().mockResolvedValue([{ s: opts.localSn }]),
      query: vi.fn().mockResolvedValue({ name: `query.${queryCall}` }),
    }),
    operations: () => ({
      wait: vi.fn().mockImplementation(() => {
        const next = opts.querySn[Math.min(queryCall, opts.querySn.length - 1)];
        queryCall++;
        if (next === 'throw') {
          return Promise.reject(new Error('operation timed out'));
        }
        return Promise.resolve({ response: { s: next } });
      }),
    }),
  };
  (kc as unknown as { client: unknown; connected: boolean }).client = stub;
  (kc as unknown as { connected: boolean }).connected = true;
}

describe('verifyGroupKelWitnessed', () => {
  it('resolves once the witnesses serve the target sn', async () => {
    const kc = new KERIClient();
    makeClient(kc, { localSn: '3', querySn: ['3'] });
    await expect(
      kc.verifyGroupKelWitnessed(GROUP, { timeoutMs: 10_000, label: 'issuance' }),
    ).resolves.toBeUndefined();
  });

  it('resolves when a witnessed sn is AHEAD of the target', async () => {
    const kc = new KERIClient();
    makeClient(kc, { localSn: '3', querySn: ['4'] });
    await expect(
      kc.verifyGroupKelWitnessed(GROUP, { timeoutMs: 10_000 }),
    ).resolves.toBeUndefined();
  });

  it('retries while witnesses lag, then resolves when they catch up', async () => {
    const kc = new KERIClient();
    // First query times out, second reports a stale sn, third serves sn=3.
    makeClient(kc, { localSn: '3', querySn: ['throw', '2', '3'] });
    await expect(
      kc.verifyGroupKelWitnessed(GROUP, { timeoutMs: 30_000 }),
    ).resolves.toBeUndefined();
  });

  it('throws loudly, naming the un-served sn, when witnesses never catch up', async () => {
    const kc = new KERIClient();
    makeClient(kc, { localSn: '3', querySn: ['throw'] });
    await expect(
      kc.verifyGroupKelWitnessed(GROUP, { timeoutMs: 100, label: 'issuance' }),
    ).rejects.toThrow(/not witness-served up to sn=3/);
  });

  it('throws when there is no local key state to target', async () => {
    const kc = new KERIClient();
    const stub = {
      state: vi.fn().mockResolvedValue({}),
      keyStates: () => ({ get: vi.fn().mockResolvedValue([]) }),
    };
    (kc as unknown as { client: unknown; connected: boolean }).client = stub;
    (kc as unknown as { connected: boolean }).connected = true;
    await expect(
      kc.verifyGroupKelWitnessed(GROUP, { timeoutMs: 100 }),
    ).rejects.toThrow(/no local key state/);
  });

  it('honours an explicit targetSn over local state', async () => {
    const kc = new KERIClient();
    // Local sn is 5 but we only require the witnesses to serve sn=2.
    makeClient(kc, { localSn: '5', querySn: ['2'] });
    await expect(
      kc.verifyGroupKelWitnessed(GROUP, { targetSn: '2', timeoutMs: 10_000 }),
    ).resolves.toBeUndefined();
  });
});
