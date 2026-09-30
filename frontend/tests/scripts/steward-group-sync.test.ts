import { describe, it, expect, vi } from 'vitest';
import { syncGroup, type GroupSyncDeps } from 'src/lib/keri/steward/groupSync';
import { GroupBehind, GroupDiverged, StewardRefusal } from 'src/lib/keri/steward/errors';

function ev(obj: Record<string, unknown>): string {
  const body = JSON.stringify({ v: 'KERI10JSON000000_', ...obj });
  return body.replace('000000', new TextEncoder().encode(body).length.toString(16).padStart(6, '0'));
}
const kel = (upTo: number) =>
  Array.from({ length: upTo + 1 }, (_, s) => ev({ t: s === 0 ? 'icp' : 'ixn', d: `E${s}`, i: 'EGRP', s: s.toString(16) }) + '-AAB' + 'A'.repeat(88)).join('');

function deps(over: Partial<GroupSyncDeps> & { local: number[] }): GroupSyncDeps {
  const local = [...over.local];
  return {
    witnessUrls: over.witnessUrls ?? (async () => ['http://w1', 'http://w2']),
    fetchText: over.fetchText ?? (async () => kel(5)),
    pushEvent: over.pushEvent ?? vi.fn(async () => true),
    localGroupSn: async () => (local.length > 1 ? local.shift()! : local[0]!),
  };
}

describe('syncGroup', () => {
  it('pushes only events above the local sn and returns the synced sn', async () => {
    const push = vi.fn(async () => true);
    const d = deps({ local: [3, 5], pushEvent: push });
    await expect(syncGroup('EGRP', 'EME', d)).resolves.toEqual({ sn: 5 });
    expect(push.mock.calls.map((c) => c[0].event.s)).toEqual(['4', '5']);
    expect(push.mock.calls[0]![1]).toBe('EME');
  });
  it('refuses when the agent is still behind after the push', async () => {
    await expect(syncGroup('EGRP', 'EME', deps({ local: [3, 4] }))).rejects.toBeInstanceOf(GroupBehind);
  });
  it('refuses when every witness is unreachable (Review Focus 2)', async () => {
    const d = deps({ local: [5], fetchText: async () => null });
    await expect(syncGroup('EGRP', 'EME', d)).rejects.toThrow(/witnesses unreachable/);
  });
  it('refuses when there is no witness config at all (Review Focus 2)', async () => {
    const d = deps({ local: [5], witnessUrls: async () => [] });
    await expect(syncGroup('EGRP', 'EME', d)).rejects.toBeInstanceOf(GroupBehind);
  });
  it('refuses when the agent is AHEAD of every witness (Review Focus 1)', async () => {
    await expect(syncGroup('EGRP', 'EME', deps({ local: [7] }))).rejects.toBeInstanceOf(GroupDiverged);
  });
  it('uses the highest sn any witness serves', async () => {
    const d = deps({ local: [5, 6], fetchText: async (u) => (u === 'http://w1/oobi/EGRP' ? kel(5) : kel(6)) });
    await expect(syncGroup('EGRP', 'EME', d)).resolves.toEqual({ sn: 6 });
  });
  it('ignores a witness event whose sn is non-hex', async () => {
    const bad = ev({ t: 'ixn', d: 'EBAD', i: 'EGRP', s: 'zz' }) + '-AAB' + 'A'.repeat(88);
    const d = deps({ local: [5], fetchText: async () => kel(5) + bad });
    await expect(syncGroup('EGRP', 'EME', d)).resolves.toEqual({ sn: 5 });
  });
  it('refuses when the only group events have invalid sn', async () => {
    const bad = ev({ t: 'ixn', d: 'EBAD', i: 'EGRP', s: 'zz' }) + '-AAB' + 'A'.repeat(88);
    await expect(syncGroup('EGRP', 'EME', deps({ local: [5], fetchText: async () => bad }))).rejects.toBeInstanceOf(GroupBehind);
  });
  it('refuses when the local sn is NaN', async () => {
    await expect(syncGroup('EGRP', 'EME', deps({ local: [NaN] }))).rejects.toBeInstanceOf(StewardRefusal);
  });
});
