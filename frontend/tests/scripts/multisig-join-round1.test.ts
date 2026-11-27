/**
 * useMultisigJoin round 1, at the composable seam (registration e2e test 5,
 * 2026-09-30): the joining member rotates its personal AID exactly once per
 * proposed group rotation — never twice from concurrent passes, never on a
 * co-signer's forward, and never again after a rotation that landed but whose
 * wait timed out (or the app died before marking the note read).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  sn: 0,
  notifications: null as unknown as { value: unknown[] },
  exn: {} as Record<string, unknown>,
}));

const rotatePersonalAid = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 20));
  h.sn += 1;
  return h.sn.toString(16);
});
const markNotificationRead = vi.fn(async () => {});

const signifyClient = {
  exchanges: () => ({ get: async () => ({ exn: h.exn }) }),
  identifiers: () => ({
    list: async () => ({ aids: [{ name: 'me', prefix: 'EJOINER' }] }),
    get: async (name: string) => {
      if (name === 'me') return { prefix: 'EJOINER', state: { s: h.sn.toString(16) } };
      throw new Error('404 not found'); // not yet a member of the org group
    },
  }),
};

vi.mock('src/lib/keri/client', () => ({
  useKERIClient: () => ({
    getSignifyClient: () => signifyClient,
    getCesrUrl: () => 'http://cesr',
    resolveOOBI: vi.fn(async () => true),
    rotatePersonalAid,
    markNotificationRead,
  }),
}));
vi.mock('src/api/config', () => ({
  getOrFetchOrgConfig: vi.fn(async () => ({ organization: { aid: 'EGROUP', name: 'matou' } })),
}));
vi.mock('src/lib/secureStorage', () => ({
  secureStorage: {
    getItem: vi.fn(async (k: string) => h.store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => { h.store.set(k, v); }),
  },
}));
vi.mock('src/composables/useKERINotificationService', async () => {
  const { ref: vref } = await import('vue');
  h.notifications = vref<unknown[]>([]);
  return { useKERINotificationService: () => ({ notifications: h.notifications, lastFetchTime: vref(0) }) };
});

import { useMultisigJoin } from 'src/composables/useMultisigJoin';

const round1Exn = (sender: string, rot = 'EROT') => ({
  i: sender,
  a: { gid: 'EGROUP', smids: ['EADMIN', 'ESTEWARD1'], rmids: ['EADMIN', 'ESTEWARD1', 'EJOINER'], round: 'round-1' },
  e: { rot: { d: rot, s: '9' } },
});
const note = { i: 'NOTE1', r: false, a: { r: '/multisig/rot', d: 'EXNSAID' } };
const HANDLED_KEY = 'matou_round1_rotations_handled';

describe('useMultisigJoin round 1', () => {
  beforeEach(() => {
    h.store.clear();
    h.sn = 0;
    h.notifications.value = [note];
    rotatePersonalAid.mockClear();
    markNotificationRead.mockClear();
  });

  it('two concurrent passes over one initiator note rotate exactly once', async () => {
    h.exn = round1Exn('EADMIN');
    const join = useMultisigJoin();
    await Promise.all([join.checkAndJoinMultisig(), join.checkAndJoinMultisig()]);
    expect(rotatePersonalAid).toHaveBeenCalledTimes(1);
    expect(markNotificationRead).toHaveBeenCalledWith('NOTE1');
    expect(JSON.parse(h.store.get(HANDLED_KEY)!)).toEqual([{ said: 'EROT', snBefore: 0 }]);
  });

  it("a co-signer's forward of the proposal is marked read and never rotates", async () => {
    h.exn = round1Exn('ESTEWARD1');
    await useMultisigJoin().checkAndJoinMultisig();
    expect(rotatePersonalAid).not.toHaveBeenCalled();
    expect(markNotificationRead).toHaveBeenCalledWith('NOTE1');
  });

  it('a recorded proposal whose rotation landed (sn advanced) is marked read, not rotated again', async () => {
    h.exn = round1Exn('EADMIN');
    h.store.set(HANDLED_KEY, JSON.stringify([{ said: 'EROT', snBefore: 0 }]));
    h.sn = 1; // the rotation committed, but its wait timed out / the app died
    await useMultisigJoin().checkAndJoinMultisig();
    expect(rotatePersonalAid).not.toHaveBeenCalled();
    expect(markNotificationRead).toHaveBeenCalledWith('NOTE1');
  });

  it('a recorded proposal whose rotation never landed (sn unchanged) rotates', async () => {
    h.exn = round1Exn('EADMIN');
    h.store.set(HANDLED_KEY, JSON.stringify([{ said: 'EROT', snBefore: 0 }]));
    await useMultisigJoin().checkAndJoinMultisig();
    expect(rotatePersonalAid).toHaveBeenCalledTimes(1);
    expect(markNotificationRead).toHaveBeenCalledWith('NOTE1');
  });

  it('the proposal is recorded before rotating, so a rotation that throws is not repeated once it landed', async () => {
    h.exn = round1Exn('EADMIN');
    rotatePersonalAid.mockImplementationOnce(async () => {
      h.sn += 1; // KERIA committed the rotation...
      throw new Error('operation wait timed out'); // ...but our wait gave up
    });
    const join = useMultisigJoin();
    await join.checkAndJoinMultisig();
    expect(markNotificationRead).not.toHaveBeenCalled(); // left unread
    await join.checkAndJoinMultisig();
    expect(rotatePersonalAid).toHaveBeenCalledTimes(1);
    expect(markNotificationRead).toHaveBeenCalledWith('NOTE1');
  });

  it('reads the legacy string[] handled shape as already rotated', async () => {
    h.exn = round1Exn('EADMIN');
    h.store.set(HANDLED_KEY, JSON.stringify(['EROT']));
    await useMultisigJoin().checkAndJoinMultisig();
    expect(rotatePersonalAid).not.toHaveBeenCalled();
    expect(markNotificationRead).toHaveBeenCalledWith('NOTE1');
  });
});
