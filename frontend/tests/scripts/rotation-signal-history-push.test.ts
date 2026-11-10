/**
 * I4 (spec §3.5): a co-signer pushes the org history to the new steward right
 * after it completes its round-2 rotation + ack — never on round 1, never
 * when its own rotation failed (no ack).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';

const lastEvent = ref<unknown>(null);
vi.mock('src/composables/useBackendEvents', () => ({ useBackendEvents: () => ({ lastEvent }) }));

const inbox = { drain: vi.fn(async () => {}), pending: { value: 0 }, lastError: { value: null } };
vi.mock('src/composables/useOrgActInbox', () => ({ useOrgActInbox: () => inbox }));

const keri = {
  getSignifyClient: () => ({
    keyStates: () => ({ query: async () => ({ name: 'op' }) }),
    operations: () => ({ wait: async () => ({}) }),
    identifiers: () => ({ list: async () => ({ aids: [{ name: 'me', prefix: 'DME' }] }) }),
  }),
  syncGroupFromWitnesses: vi.fn(async () => ({ sn: 7 })),
  rotatePersonalAid: vi.fn(async () => 3),
  groupKeyState: vi.fn(async () => ({ k: ['DA', 'DME2', 'DNEW'], latestEstSn: 7, memberKey: 'DME2' })),
  pushOrgHistory: vi.fn(async () => 1),
};
vi.mock('src/lib/keri/client', () => ({ useKERIClient: () => keri }));
vi.mock('src/lib/keri/registry', () => ({ resolveOrgRegistryId: vi.fn(async () => 'EREG') }));
vi.mock('src/lib/api/client', () => ({ BACKEND_URL: 'http://backend', authHeaders: () => ({}) }));
vi.mock('src/lib/secureStorage', () => ({ secureStorage: { getItem: vi.fn(async () => null) } }));

import { useMultisigRotationSignal } from 'src/composables/useMultisigRotationSignal';

let n = 0;
const signal = (round: 'round-1' | 'round-2', action: 'rotate' | 'query' = 'rotate') => ({
  type: 'multisig:rotation-signal',
  data: { signalId: `S${++n}`, adminAid: 'DADMIN', adminSn: '4', targetMemberAid: 'DME', round, groupAid: 'EGRP', action },
});

async function fire(evt: unknown) {
  lastEvent.value = evt;
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
}

describe('useMultisigRotationSignal — history push after round 2 (I4)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    keri.pushOrgHistory.mockClear();
    keri.rotatePersonalAid.mockReset().mockResolvedValue(3);
    lastEvent.value = null;
  });

  it('pushes the history once the round-2 group rotation has our key', async () => {
    const s = useMultisigRotationSignal();
    s.start('DME');
    await fire(signal('round-2'));
    await vi.waitFor(() => expect(keri.pushOrgHistory).toHaveBeenCalledWith('EGRP', 'EREG'));
    s.stop();
  });

  it('does not push after round 1', async () => {
    const s = useMultisigRotationSignal();
    s.start('DME');
    await fire(signal('round-1'));
    await new Promise((r) => setTimeout(r, 10));
    expect(keri.pushOrgHistory).not.toHaveBeenCalled();
    s.stop();
  });

  it('does not push when our own rotation failed (no ack)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    keri.rotatePersonalAid.mockRejectedValue(new Error('rotation failed'));
    const s = useMultisigRotationSignal();
    s.start('DME');
    await fire(signal('round-2'));
    await new Promise((r) => setTimeout(r, 10));
    expect(keri.pushOrgHistory).not.toHaveBeenCalled();
    s.stop();
  });
});
