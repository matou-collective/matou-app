import { describe, it, expect, vi } from 'vitest';
import { KERIClient } from 'src/lib/keri/client';

/**
 * Unit coverage for KERIClient.awaitGroupAnchorWitnessed — the issue #51
 * issuer-side gate. A group-AID registry `vcp` / credential `iss` is anchored
 * by an `ixn` that KERIA registers as a SEPARATE long-running op named
 * `group.<ixn SAID>`; that op only completes once the Counselor has collected
 * a receipt from EVERY witness (keri/app/grouping.py). The `registry` /
 * `credential` ops the client normally waits on complete on the LOCAL anchor,
 * so this helper polls the group op instead. We stub the signify client: the
 * polling/timeout logic is what we assert.
 */

const IXN_SAID = 'EIxnSaidOfTheAnchoringInteractionEvent00000';

function makeClient(kc: KERIClient, statuses: Array<{ done: boolean } | 'throw'>) {
  let call = 0;
  const get = vi.fn().mockImplementation(async (name: string) => {
    const next = statuses[Math.min(call, statuses.length - 1)];
    call++;
    if (next === 'throw') throw new Error('404 not found');
    return { name, done: next.done, response: next.done ? { t: 'ixn', s: '5' } : undefined };
  });
  const stub = {
    state: vi.fn().mockResolvedValue({}),
    operations: () => ({ get }),
  };
  (kc as unknown as { client: unknown; connected: boolean }).client = stub;
  (kc as unknown as { connected: boolean }).connected = true;
  return get;
}

describe('awaitGroupAnchorWitnessed', () => {
  it('polls the group op by name and resolves once it is done', async () => {
    const kc = new KERIClient();
    const get = makeClient(kc, [{ done: true }]);
    await expect(
      kc.awaitGroupAnchorWitnessed(IXN_SAID, { timeoutMs: 10_000, label: 'issuance', pollMs: 1 }),
    ).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledWith(`group.${IXN_SAID}`);
  });

  it('keeps polling while witnesses have not all receipted, then resolves', async () => {
    const kc = new KERIClient();
    const get = makeClient(kc, [{ done: false }, { done: false }, { done: true }]);
    await expect(
      kc.awaitGroupAnchorWitnessed(IXN_SAID, { timeoutMs: 10_000, pollMs: 1 }),
    ).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('tolerates a transient fetch error and resolves on a later poll', async () => {
    const kc = new KERIClient();
    makeClient(kc, ['throw', { done: true }]);
    await expect(
      kc.awaitGroupAnchorWitnessed(IXN_SAID, { timeoutMs: 10_000, pollMs: 1 }),
    ).resolves.toBeUndefined();
  });

  it('throws loudly, naming the ixn, when the witnesses never receipt it', async () => {
    const kc = new KERIClient();
    makeClient(kc, [{ done: false }]);
    await expect(
      kc.awaitGroupAnchorWitnessed(IXN_SAID, { timeoutMs: 30, pollMs: 1, label: 'issuance' }),
    ).rejects.toThrow(new RegExp(`group\\.${IXN_SAID}.*not witness-receipted`));
  });
});
