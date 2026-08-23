import { describe, it, expect, vi } from 'vitest';
import { KERIClient } from 'src/lib/keri/client';

/**
 * Unit coverage for the issue #63 group-KEL sync:
 *  - syncGroupIxnNotifications applies peers' /multisig/ixn notifications in
 *    sn order via identifiers().interact, only when our tip is the ixn's
 *    prior, marks already-held ones read, defers when behind, and throws on a
 *    SAID mismatch (fork).
 *  - sendMultisigIxnExn embeds the local group event at the requested sn and
 *    addresses every other member.
 * The signify client is stubbed; no KERIA needed.
 */

const GID = 'EGroupAidPrefix000000000000000000000000000000';
const ME = 'EMyPersonalAid00000000000000000000000000000';
const PEER = 'EPeerPersonalAid000000000000000000000000000';

function ixn(sn: number, p: string, d: string, data: unknown[] = [{ i: 'Ereg', s: '0', d: 'Ereg' }]) {
  return { v: 'KERI10JSON00013a_', t: 'ixn', d, i: GID, s: sn.toString(16), p, a: data };
}

interface StubOpts {
  localSn: number;
  localD: string;
  notes: Array<{ i: string; r: boolean; a: { r: string; d: string } }>;
  exns: Record<string, { a: { gid: string }; e: { ixn: ReturnType<typeof ixn> } }>;
  recreatedSaid?: (data: unknown[]) => string;
}

function stub(kc: KERIClient, o: StubOpts) {
  const state = { s: o.localSn.toString(16), d: o.localD };
  const interact = vi.fn().mockImplementation(async (_name: string, data: unknown[]) => {
    const said = o.recreatedSaid ? o.recreatedSaid(data) : 'Erecreated';
    // Applying advances our local tip, like KERIA would.
    state.s = (parseInt(state.s, 16) + 1).toString(16);
    state.d = said;
    return { serder: { said, sad: { d: said, s: state.s } }, op: async () => ({ name: `group.${said}`, done: true }) };
  });
  const mark = vi.fn().mockResolvedValue(undefined);
  const query = vi.fn().mockResolvedValue({ name: 'query.x' });
  const client = {
    state: vi.fn().mockResolvedValue({}),
    identifiers: () => ({
      get: vi.fn().mockImplementation(async (name: string) => ({ name, prefix: GID, state: { ...state }, group: {} })),
      list: vi.fn().mockResolvedValue({ aids: [{ name: 'me', prefix: ME }, { name: 'org', prefix: GID, group: {} }] }),
      interact,
    }),
    notifications: () => ({ list: vi.fn().mockResolvedValue({ notes: o.notes }), mark }),
    exchanges: () => ({ get: vi.fn().mockImplementation(async (said: string) => ({ exn: o.exns[said] })), send: vi.fn().mockResolvedValue({}) }),
    operations: () => ({ wait: vi.fn().mockResolvedValue({ done: true }) }),
    keyStates: () => ({ query, get: vi.fn().mockResolvedValue([{ s: state.s }]) }),
    keyEvents: () => ({ get: vi.fn().mockResolvedValue([]) }),
  };
  (kc as unknown as { client: unknown; connected: boolean }).client = client;
  (kc as unknown as { connected: boolean }).connected = true;
  return { interact, mark, query, client };
}

describe('syncGroupIxnNotifications', () => {
  it('applies a peer ixn whose prior is our tip, waits on the group op, marks the note read', async () => {
    const kc = new KERIClient();
    const peerIxn = ixn(8, 'Etip7', 'Esaid8');
    const { interact, mark } = stub(kc, {
      localSn: 7, localD: 'Etip7',
      notes: [{ i: 'n1', r: false, a: { r: '/multisig/ixn', d: 'Eexn1' } }],
      exns: { Eexn1: { a: { gid: GID }, e: { ixn: peerIxn } } },
      recreatedSaid: () => 'Esaid8',
    });
    await expect(kc.syncGroupIxnNotifications('org')).resolves.toBe(1);
    expect(interact).toHaveBeenCalledWith('org', peerIxn.a);
    expect(mark).toHaveBeenCalledWith('n1');
  });

  it('applies two pending ixns in sn order even if notifications arrive out of order', async () => {
    const kc = new KERIClient();
    const { interact } = stub(kc, {
      localSn: 7, localD: 'Etip7',
      notes: [
        { i: 'n9', r: false, a: { r: '/multisig/ixn', d: 'Eexn9' } },
        { i: 'n8', r: false, a: { r: '/multisig/ixn', d: 'Eexn8' } },
      ],
      exns: {
        Eexn9: { a: { gid: GID }, e: { ixn: ixn(9, 'Esaid8', 'Esaid9', [{ i: 'Ecred', s: '0', d: 'Eiss' }]) } },
        Eexn8: { a: { gid: GID }, e: { ixn: ixn(8, 'Etip7', 'Esaid8') } },
      },
      recreatedSaid: (data) => ((data[0] as { i: string }).i === 'Ereg' ? 'Esaid8' : 'Esaid9'),
    });
    await expect(kc.syncGroupIxnNotifications('org')).resolves.toBe(2);
    expect(interact.mock.calls.map((c) => (c[1] as Array<{ i: string }>)[0].i)).toEqual(['Ereg', 'Ecred']);
  });

  it('marks read without re-creating when we already hold that sn', async () => {
    const kc = new KERIClient();
    const { interact, mark } = stub(kc, {
      localSn: 8, localD: 'Esaid8',
      notes: [{ i: 'n1', r: false, a: { r: '/multisig/ixn', d: 'Eexn1' } }],
      exns: { Eexn1: { a: { gid: GID }, e: { ixn: ixn(8, 'Etip7', 'Esaid8') } } },
    });
    await expect(kc.syncGroupIxnNotifications('org')).resolves.toBe(0);
    expect(interact).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith('n1');
  });

  it('defers (pulls KEL, leaves note unread) when our tip is behind the ixn prior', async () => {
    const kc = new KERIClient();
    const { interact, mark, query } = stub(kc, {
      localSn: 5, localD: 'Etip5',
      notes: [{ i: 'n1', r: false, a: { r: '/multisig/ixn', d: 'Eexn1' } }],
      exns: { Eexn1: { a: { gid: GID }, e: { ixn: ixn(8, 'Etip7', 'Esaid8') } } },
    });
    await expect(kc.syncGroupIxnNotifications('org')).resolves.toBe(0);
    expect(interact).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(GID, '7', undefined);
  });

  it('throws loudly when the re-created ixn SAID differs from the peer (forked KEL)', async () => {
    const kc = new KERIClient();
    const { mark } = stub(kc, {
      localSn: 7, localD: 'Etip7',
      notes: [{ i: 'n1', r: false, a: { r: '/multisig/ixn', d: 'Eexn1' } }],
      exns: { Eexn1: { a: { gid: GID }, e: { ixn: ixn(8, 'Etip7', 'Esaid8') } } },
      recreatedSaid: () => 'Edifferent',
    });
    await expect(kc.syncGroupIxnNotifications('org')).rejects.toThrow(/forked/);
    expect(mark).not.toHaveBeenCalled();
  });

  it('ignores notifications for other groups and read ones', async () => {
    const kc = new KERIClient();
    const { interact } = stub(kc, {
      localSn: 7, localD: 'Etip7',
      notes: [
        { i: 'n1', r: true, a: { r: '/multisig/ixn', d: 'Eexn1' } },
        { i: 'n2', r: false, a: { r: '/multisig/ixn', d: 'Eexn2' } },
        { i: 'n3', r: false, a: { r: '/multisig/rot', d: 'Eexn3' } },
      ],
      exns: {
        Eexn1: { a: { gid: GID }, e: { ixn: ixn(8, 'Etip7', 'Esaid8') } },
        Eexn2: { a: { gid: 'EOtherGroup' }, e: { ixn: ixn(8, 'Etip7', 'Esaid8') } },
      },
    });
    await expect(kc.syncGroupIxnNotifications('org')).resolves.toBe(0);
    expect(interact).not.toHaveBeenCalled();
  });
});

describe('sendMultisigIxnExn', () => {
  it('embeds the local group event at the requested sn and sends to the other members', async () => {
    const kc = new KERIClient();
    const { client } = stub(kc, { localSn: 8, localD: 'Esaid8', notes: [], exns: {} });
    const send = vi.fn().mockResolvedValue({});
    const evt8 = ixn(8, 'Etip7', 'Esaid8');
    client.exchanges = () => ({ get: vi.fn(), send }) as never;
    client.keyEvents = () => ({ get: vi.fn().mockResolvedValue([{ ked: ixn(7, 'x', 'Etip7'), atc: '-A' }, { ked: evt8, atc: '-AAB\n' }]) }) as never;
    vi.spyOn(kc, 'getGroupMemberRecipients').mockResolvedValue([PEER]);

    await expect(kc.sendMultisigIxnExn('org', '8')).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const [senderName, topic, , route, payload, embeds, recipients] = send.mock.calls[0] as unknown[];
    expect(senderName).toBe('me');
    expect(topic).toBe('org');
    expect(route).toBe('/multisig/ixn');
    expect(payload).toEqual({ gid: GID, smids: [ME, PEER] });
    expect((embeds as { ixn: [unknown, string] }).ixn[1]).toBe('-AAB');
    expect(recipients).toEqual([PEER]);
  });

  it('sends nothing when no other member is known', async () => {
    const kc = new KERIClient();
    const { client } = stub(kc, { localSn: 8, localD: 'Esaid8', notes: [], exns: {} });
    const send = vi.fn();
    client.exchanges = () => ({ get: vi.fn(), send }) as never;
    client.keyEvents = () => ({ get: vi.fn().mockResolvedValue([{ ked: ixn(8, 'Etip7', 'Esaid8'), atc: '' }]) }) as never;
    vi.spyOn(kc, 'getGroupMemberRecipients').mockResolvedValue([]);
    await expect(kc.sendMultisigIxnExn('org', '8')).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
