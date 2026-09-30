import { describe, it, expect, vi } from 'vitest';
import { processOrgActNotes } from 'src/composables/useOrgActInbox';

const note = (i: string, r = '/multisig/iss', read = false) => ({ i, r: read, a: { r, d: `EX${i}` } });

describe('processOrgActNotes', () => {
  const org = { group: 'EGRP', registry: 'EREG' };
  const exnFor = (gid: string) => ({ exn: { r: '/multisig/iss', a: { gid }, e: { acdc: { d: 'EC', ri: 'EREG' }, iss: { t: 'iss' }, anc: { t: 'ixn', s: '9' } } }, paths: { anc: '-AAB' + 'AB' + 's'.repeat(86) } });

  it('replays ours oldest-first and marks each read after success', async () => {
    const mark = vi.fn(async () => {});
    const replay = vi.fn(async () => 'applied' as const);
    const res = await processOrgActNotes([note('1'), note('2')], { org, getRequest: async () => [exnFor('EGRP')], replay, mark });
    expect(res).toEqual({ applied: 2, failed: 0 });
    expect(mark.mock.calls.map((c) => c[0])).toEqual(['1', '2']);
  });
  it('marks a foreign group act read without replaying (Review Focus 4)', async () => {
    const mark = vi.fn(async () => {});
    const replay = vi.fn();
    await processOrgActNotes([note('1')], { org, getRequest: async () => [exnFor('EOTHER')], replay, mark });
    expect(replay).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith('1');
  });
  it('leaves a failed replay unread and counts it', async () => {
    const mark = vi.fn(async () => {});
    const res = await processOrgActNotes([note('1')], { org, getRequest: async () => [exnFor('EGRP')], replay: async () => { throw new Error('boom'); }, mark });
    expect(res.failed).toBe(1);
    expect(mark).not.toHaveBeenCalled();
  });
  it('marks read only after the replay has returned (R8: KERIA never re-notifies)', async () => {
    const order: string[] = [];
    await processOrgActNotes([note('1')], {
      org,
      getRequest: async () => [exnFor('EGRP')],
      replay: async () => { order.push('replay'); return 'already' as const; },
      mark: async () => { order.push('mark'); },
    });
    expect(order).toEqual(['replay', 'mark']);
  });
  it('ignores read notes and other routes', async () => {
    const replay = vi.fn();
    await processOrgActNotes([note('1', '/multisig/iss', true), note('2', '/multisig/rot')], { org, getRequest: async () => [], replay, mark: async () => {} });
    expect(replay).not.toHaveBeenCalled();
  });
});
