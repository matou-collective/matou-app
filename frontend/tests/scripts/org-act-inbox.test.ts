import { describe, it, expect, vi } from 'vitest';
import { processOrgActNotes, selectOrgActNotes } from 'src/composables/useOrgActInbox';
import { NotSignerYet } from 'src/lib/keri/steward/errors';

const note = (i: string, r = '/multisig/iss', read = false) => ({ i, r: read, a: { r, d: `EX${i}` } });

describe('processOrgActNotes', () => {
  const org = { group: 'EGRP', registry: 'EREG' };
  const exnFor = (gid: string) => ({ exn: { r: '/multisig/iss', a: { gid }, e: { acdc: { d: 'EC', ri: 'EREG' }, iss: { t: 'iss' }, anc: { t: 'ixn', s: '9' } } }, paths: { anc: '-AAB' + 'AB' + 's'.repeat(86) } });

  it('replays ours oldest-first and marks each read after success', async () => {
    const mark = vi.fn(async () => {});
    const replay = vi.fn(async () => 'applied' as const);
    const res = await processOrgActNotes([note('1'), note('2')], { org, getRequest: async () => [exnFor('EGRP')], replay, mark });
    expect(res).toEqual({ applied: 2, failed: 0, waiting: 0 });
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
  it('a note an earlier pass already marked read (signify 404) is applied, not failed (R13)', async () => {
    const mark = vi.fn(async () => { throw new Error('HTTP DELETE /notifications/1 - 404 Not Found - {"msg": "no notification to mark as read for 1"}'); });
    const res = await processOrgActNotes([note('1')], { org, getRequest: async () => [exnFor('EGRP')], replay: async () => 'already' as const, mark });
    expect(res).toEqual({ applied: 1, failed: 0, waiting: 0 });
  });
  it('any other mark error after a successful replay is not a failed replay', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await processOrgActNotes([note('1')], { org, getRequest: async () => [exnFor('EGRP')], replay: async () => 'applied' as const, mark: async () => { throw new Error('socket hang up'); } });
    expect(res).toEqual({ applied: 1, failed: 0, waiting: 0 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('processOrgActNotes — NotSignerYet (C1)', () => {
  const org = { group: 'EGRP', registry: 'EREG' };
  const exn = { exn: { r: '/multisig/iss', a: { gid: 'EGRP' }, e: { acdc: { d: 'EC', ri: 'EREG' }, iss: { t: 'iss' }, anc: { t: 'ixn', s: '9' } } }, paths: { anc: '-AAB' + 'AB' + 's'.repeat(86) } };

  it('leaves the note unread, counts it waiting (pending), and logs quietly — not a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const mark = vi.fn(async () => {});
    const res = await processOrgActNotes([note('1')], {
      org, getRequest: async () => [exn], mark,
      replay: async () => { throw new NotSignerYet('member key not in k'); },
    });
    expect(res).toEqual({ applied: 0, failed: 0, waiting: 1 });
    expect(mark).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
    warn.mockRestore();
    debug.mockRestore();
  });
});

describe('selectOrgActNotes', () => {
  it('takes only unread org acts, oldest-first', () => {
    const at = (n: ReturnType<typeof note>, dt: string) => ({ ...n, a: { ...n.a, dt } });
    const picked = selectOrgActNotes([
      at(note('2'), '2026-09-30T10:00:02Z'),
      at(note('1'), '2026-09-30T10:00:01Z'),
      at(note('3', '/multisig/rev'), '2026-09-30T10:00:03Z'),
      note('4', '/multisig/rot'),
    ]);
    expect(picked.map((n) => n.i)).toEqual(['1', '2', '3']);
  });
  it('a note the fresh agent list shows read is not processed, though the stale cache showed it unread', () => {
    const cached = [note('1')];
    const fresh = [note('1', '/multisig/iss', true)];
    expect(selectOrgActNotes(cached)).toHaveLength(1);
    expect(selectOrgActNotes(fresh)).toHaveLength(0);
  });
});
