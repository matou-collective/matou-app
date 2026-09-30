import { describe, it, expect, vi } from 'vitest';
import { replayAct, cosignPolicy, type ReplayDeps, type ReplayInput } from 'src/lib/keri/steward/replay';
import { ReplayFailed } from 'src/lib/keri/steward/errors';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const sig = (i: number) => `A${B64[i]}` + 's'.repeat(86);
const anc = (sn: number) => ({ raw: `{"s":"${sn.toString(16)}"}`, sad: { t: 'ixn', s: sn.toString(16), d: `EANC${sn}` }, sigs: [sig(1)] });
const iss: ReplayInput = { kind: 'iss', registry: 'EREG', acdc: { d: 'ECRED' }, event: { t: 'iss', d: 'EISS' }, anc: anc(9) };
const rev: ReplayInput = { kind: 'rev', registry: 'EREG', acdc: { d: 'ECRED' }, event: { t: 'rev', d: 'EREV' }, anc: anc(10),
  issForRev: { event: { t: 'iss', d: 'EISS' }, anc: anc(9) } };

function deps(over: Partial<ReplayDeps> = {}): ReplayDeps {
  return {
    credentialState: vi.fn(async () => null),
    ownSigs: vi.fn(async () => [sig(0)]),
    postIss: vi.fn(async () => 200),
    deleteRev: vi.fn(async () => 200),
    sync: vi.fn(async () => {}),
    keyState: async () => ({ k: ['DKEY0', 'DKEY1'], latestEstSn: 8, memberKey: 'DKEY0' }),
    ...over,
  };
}

describe('cosignPolicy', () => {
  it('signs ixns after the latest establishment event', () => {
    expect(cosignPolicy(9, { k: ['A', 'B'], latestEstSn: 8, memberKey: 'B' })).toEqual({ sign: true, skip: false });
  });
  it('does not sign older ixns, and a non-keys[0] steward still replays', () => {
    expect(cosignPolicy(5, { k: ['A', 'B'], latestEstSn: 8, memberKey: 'B' })).toEqual({ sign: false, skip: false });
  });
  it('keys[0] skips an older ixn it cannot sign (Review Focus 5)', () => {
    expect(cosignPolicy(5, { k: ['A', 'B'], latestEstSn: 8, memberKey: 'A' })).toEqual({ sign: false, skip: true });
  });
});

describe('replayAct', () => {
  it('posts the iss with the sender sigs merged with our own', async () => {
    const d = deps();
    await expect(replayAct(iss, d)).resolves.toBe('applied');
    const body = (d.postIss as any).mock.calls[0][0];
    expect(body.sigs).toEqual([sig(0), sig(1)]);
    expect(body.ixn).toEqual(iss.anc.sad);
  });
  it('is idempotent: already-applied state posts nothing (Review Focus 3)', async () => {
    const d = deps({ credentialState: async () => 'iss' });
    await expect(replayAct(iss, d)).resolves.toBe('already');
    expect(d.postIss).not.toHaveBeenCalled();
  });
  it('a rev already applied is "already"', async () => {
    await expect(replayAct(rev, deps({ credentialState: async () => 'rev' }))).resolves.toBe('already');
  });
  it('replays the issuance first when a rev arrives for an unknown credential', async () => {
    const d = deps();
    await expect(replayAct(rev, d)).resolves.toBe('applied');
    expect(d.postIss).toHaveBeenCalledTimes(1);
    expect(d.deleteRev).toHaveBeenCalledWith('ECRED', expect.objectContaining({ rev: rev.event }));
  });
  it('fails a rev for an unknown credential that carries no issuance', async () => {
    await expect(replayAct({ ...rev, issForRev: undefined }, deps())).rejects.toBeInstanceOf(ReplayFailed);
  });
  it('on 500 syncs and retries once, then succeeds', async () => {
    const post = vi.fn().mockResolvedValueOnce(500).mockResolvedValueOnce(200);
    const d = deps({ postIss: post });
    await expect(replayAct(iss, d)).resolves.toBe('applied');
    expect(d.sync).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
  });
  it('fails after the one retry', async () => {
    await expect(replayAct(iss, deps({ postIss: async () => 500 }))).rejects.toBeInstanceOf(ReplayFailed);
  });
  it('keys[0] skips without POSTing an ixn older than the last rotation (Review Focus 5)', async () => {
    const d = deps({ keyState: async () => ({ k: ['DKEY0', 'DKEY1'], latestEstSn: 12, memberKey: 'DKEY0' }) });
    await expect(replayAct(iss, d)).resolves.toBe('skipped');
    expect(d.postIss).not.toHaveBeenCalled();
  });
  it('rejects an anchor whose sn is not strict hex instead of treating it as NaN', async () => {
    const bad = { ...iss, anc: { ...iss.anc, sad: { ...iss.anc.sad, s: 'zz' } } };
    const d = deps({ keyState: async () => ({ k: ['DKEY0', 'DKEY1'], latestEstSn: 8, memberKey: 'DKEY1' }) });
    await expect(replayAct(bad, d)).rejects.toBeInstanceOf(ReplayFailed);
    expect(d.postIss).not.toHaveBeenCalled();
  });
});
