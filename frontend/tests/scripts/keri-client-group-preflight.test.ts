/**
 * KERIClient.issueCredential / revokeCredential group preflight and
 * replication (steward peer registry, spec §4.1 / §3.3). Every group-anchored
 * act is preceded by a witness sync (and, for issuance, registry adoption) —
 * a refusal must stop the act BEFORE anything is anchored — and followed by
 * replication to the other stewards, recording only delivered peers. A
 * personal-AID act runs none of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KERIClient } from 'src/lib/keri/client';
import { GroupBehind, GroupDiverged, RegistryNotAdopted } from 'src/lib/keri/steward/errors';

const store = new Map<string, string>();
vi.mock('src/lib/secureStorage', () => ({
  secureStorage: {
    getItem: vi.fn(async (k: string) => store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  },
}));

const GROUP = 'EGROUP00000000000000000000000000000000000000';
const MEMBER = 'DMEMBER0000000000000000000000000000000000000';
const PERSONAL = 'DPERSONAL000000000000000000000000000000000';
const REG = 'EREGISTRY000000000000000000000000000000000';
const CRED = 'ECRED0000000000000000000000000000000000000';
const RECIPIENT = 'DRECIPIENT00000000000000000000000000000000';

const groupHab = { name: 'matou', prefix: GROUP, group: { mhab: { prefix: MEMBER, name: 'me' } } };
const personalHab = { name: 'me', prefix: PERSONAL };

type Hab = Record<string, unknown> & { name: string; prefix: string };

function setup(opts: { hab: Hab; getFailsFor?: string[]; listEntry?: Hab }) {
  const kc = new KERIClient();
  const calls: string[] = [];
  const get = vi.fn(async (nameOrPrefix: string) => {
    calls.push(`get:${nameOrPrefix}`);
    if (opts.getFailsFor?.includes(nameOrPrefix)) throw new Error(`404 ${nameOrPrefix}`);
    return opts.hab;
  });
  // A list() summary never carries `group` — the fail-open this guards against.
  const listEntry = opts.listEntry ?? { name: opts.hab.name, prefix: opts.hab.prefix };
  const issue = vi.fn(async () => {
    calls.push('issue');
    return { op: { name: 'op' }, acdc: { said: CRED }, iss: {}, anc: { said: 'EANC' } };
  });
  const revoke = vi.fn(async () => {
    calls.push('revoke');
    return { op: { name: 'op' }, anc: { said: 'EANC' } };
  });
  const stub = {
    state: vi.fn(async () => ({})),
    identifiers: () => ({ get, list: vi.fn(async () => ({ aids: [listEntry] })) }),
    credentials: () => ({ issue, revoke }),
    operations: () => ({ wait: vi.fn(async () => ({ done: true })) }),
    ipex: () => ({
      grant: vi.fn(async () => [{ ked: { d: 'EGRANT' } }, ['sig'], '-end']),
      submitGrant: vi.fn(async () => { calls.push('submitGrant'); }),
    }),
  };
  (kc as unknown as { client: unknown }).client = stub;
  (kc as unknown as { connected: boolean }).connected = true;

  const spies = {
    sync: vi.spyOn(kc, 'syncGroupFromWitnesses').mockImplementation(async () => { calls.push('sync'); return undefined as never; }),
    adopt: vi.spyOn(kc, 'ensureOrgRegistryAdopted').mockImplementation(async () => { calls.push('adopt'); return 'present' as never; }),
    witnessed: vi.spyOn(kc, 'awaitGroupAnchorWitnessed').mockImplementation(async () => { calls.push('witnessed'); }),
    pushKel: vi.spyOn(kc, 'pushKelToAgent').mockImplementation(async () => ({ pushed: 1, failed: 0 })),
    signers: vi.spyOn(kc, 'otherGroupSigners').mockImplementation(async () => ['DPEER1', 'DPEER2']),
    send: vi.spyOn(kc, 'sendOrgAct').mockImplementation(async (_g, _s, kind) => { calls.push(`send:${kind}`); return ['DPEER1']; }),
  };
  return { kc, calls, issue, revoke, get, spies };
}

const issueArgs = (kc: KERIClient, issuer: string) =>
  kc.issueCredential(issuer, REG, 'ESCHEMA', RECIPIENT, { role: 'Member' });

describe('KERIClient group preflight and replication', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    store.clear();
  });

  it('(a) group issue: sync, then adopt, BEFORE credentials().issue; replicates after the witnessed anchor', async () => {
    const t = setup({ hab: groupHab });
    await issueArgs(t.kc, 'matou');
    const order = t.calls.filter((c) => !c.startsWith('get:'));
    expect(order.slice(0, 3)).toEqual(['sync', 'adopt', 'issue']);
    expect(order.indexOf('witnessed')).toBeGreaterThan(order.indexOf('issue'));
    expect(order.indexOf('send:iss')).toBeGreaterThan(order.indexOf('witnessed'));
    expect(t.spies.adopt).toHaveBeenCalledWith(GROUP, REG);
  });

  it('(a) group issue refused on GroupBehind: nothing is issued', async () => {
    const t = setup({ hab: groupHab });
    t.spies.sync.mockRejectedValueOnce(new GroupBehind('kel sn 3 < witness sn 5'));
    await expect(issueArgs(t.kc, 'matou')).rejects.toBeInstanceOf(GroupBehind);
    expect(t.issue).not.toHaveBeenCalled();
    expect(t.spies.adopt).not.toHaveBeenCalled();
  });

  it('(a) group issue refused on RegistryNotAdopted: nothing is issued', async () => {
    const t = setup({ hab: groupHab });
    t.spies.adopt.mockRejectedValueOnce(new RegistryNotAdopted('no held credential'));
    await expect(issueArgs(t.kc, 'matou')).rejects.toBeInstanceOf(RegistryNotAdopted);
    expect(t.issue).not.toHaveBeenCalled();
  });

  it('(b) group revoke: sync BEFORE credentials().revoke, replicates after', async () => {
    const t = setup({ hab: groupHab });
    await t.kc.revokeCredential(GROUP, CRED);
    const order = t.calls.filter((c) => !c.startsWith('get:'));
    expect(order).toEqual(['sync', 'revoke', 'witnessed', 'send:rev']);
  });

  it('(b) group revoke refused on GroupDiverged: nothing is revoked', async () => {
    const t = setup({ hab: groupHab });
    t.spies.sync.mockRejectedValueOnce(new GroupDiverged('ahead of every witness'));
    await expect(t.kc.revokeCredential(GROUP, CRED)).rejects.toBeInstanceOf(GroupDiverged);
    expect(t.revoke).not.toHaveBeenCalled();
  });

  it('(b) revoke of an unknown issuer throws with the underlying error as cause', async () => {
    const t = setup({ hab: groupHab, getFailsFor: ['nope'] });
    const err = await t.kc.revokeCredential('nope', CRED).catch((e: unknown) => e) as Error & { cause?: unknown };
    expect(err.message).toMatch(/Issuer AID "nope" not found/);
    expect((err.cause as Error).message).toBe('404 nope');
    expect(t.revoke).not.toHaveBeenCalled();
  });

  it('(c) list() fallback re-gets the hab by name and still runs the preflight', async () => {
    // get(prefix) fails; list() finds the entry (no `group`) by prefix; re-get by name succeeds.
    const t = setup({ hab: groupHab, getFailsFor: [GROUP], listEntry: { name: 'matou', prefix: GROUP } });
    await t.kc.issueCredential(GROUP, REG, 'ESCHEMA', RECIPIENT, {});
    expect(t.get).toHaveBeenCalledWith('matou');
    expect(t.calls.filter((c) => !c.startsWith('get:')).slice(0, 3)).toEqual(['sync', 'adopt', 'issue']);
  });

  it('(c) list() fallback whose re-get also fails: throws, never issues', async () => {
    const t = setup({ hab: groupHab, getFailsFor: [GROUP, 'matou'], listEntry: { name: 'matou', prefix: GROUP } });
    await expect(t.kc.issueCredential(GROUP, REG, 'ESCHEMA', RECIPIENT, {})).rejects.toThrow(/Issuer AID/);
    expect(t.issue).not.toHaveBeenCalled();
  });

  it('(d) the sent-ledger records only the recipients sendOrgAct delivered to', async () => {
    const t = setup({ hab: groupHab });
    await issueArgs(t.kc, 'matou');
    expect(t.spies.send).toHaveBeenCalledWith(GROUP, CRED, 'iss', ['DPEER1', 'DPEER2']);
    expect(JSON.parse(store.get(`matou_org_acts_sent:${GROUP}`)!)).toEqual({ DPEER1: { [CRED]: 'iss' } });
  });

  it('(d) a corrupt ledger is replaced, not fatal', async () => {
    store.set(`matou_org_acts_sent:${GROUP}`, '[not json');
    const t = setup({ hab: groupHab });
    await t.kc.revokeCredential(GROUP, CRED);
    expect(JSON.parse(store.get(`matou_org_acts_sent:${GROUP}`)!)).toEqual({ DPEER1: { [CRED]: 'rev' } });
  });

  it('(e) personal-AID issue and revoke run none of the group steps', async () => {
    const t = setup({ hab: personalHab });
    await issueArgs(t.kc, 'me');
    await t.kc.revokeCredential('me', CRED);
    expect(t.issue).toHaveBeenCalled();
    expect(t.revoke).toHaveBeenCalled();
    for (const s of [t.spies.sync, t.spies.adopt, t.spies.witnessed, t.spies.signers, t.spies.send]) {
      expect(s).not.toHaveBeenCalled();
    }
    expect(store.size).toBe(0);
  });
});
