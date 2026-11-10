import { describe, it, expect, vi } from 'vitest';
import { pushHistoryWhenSigner, type PromotionHistoryDeps } from 'src/lib/keri/steward/promotionHistory';

function deps(keyStates: Array<{ k: string[]; latestEstSn: number; memberKey: string }>, over: Partial<PromotionHistoryDeps> = {}): PromotionHistoryDeps {
  const ks = [...keyStates];
  return {
    sync: vi.fn(async () => {}),
    keyState: vi.fn(async () => (ks.length > 1 ? ks.shift()! : ks[0]!)),
    resolveRegistry: vi.fn(async () => 'EREG'),
    pushHistory: vi.fn(async () => 2),
    sleep: vi.fn(async () => {}),
    ...over,
  };
}

describe('pushHistoryWhenSigner (spec §3.5: history pushed right after a promotion)', () => {
  it('pushes at once when our key is already one of the group keys', async () => {
    const d = deps([{ k: ['DA', 'DB'], latestEstSn: 4, memberKey: 'DA' }]);
    await expect(pushHistoryWhenSigner('EGRP', d)).resolves.toBe(true);
    expect(d.sync).toHaveBeenCalledWith('EGRP');
    expect(d.pushHistory).toHaveBeenCalledWith('EGRP', 'EREG');
    expect(d.sleep).not.toHaveBeenCalled();
  });
  it('waits for the group rotation that puts our rotated key in k, then pushes', async () => {
    const d = deps([
      { k: ['DA', 'DB'], latestEstSn: 4, memberKey: 'DB2' },
      { k: ['DA', 'DB'], latestEstSn: 4, memberKey: 'DB2' },
      { k: ['DA2', 'DB2', 'DC'], latestEstSn: 5, memberKey: 'DB2' },
    ]);
    await expect(pushHistoryWhenSigner('EGRP', d, { attempts: 5, intervalMs: 1 })).resolves.toBe(true);
    expect(d.sleep).toHaveBeenCalledTimes(2);
    expect(d.pushHistory).toHaveBeenCalledTimes(1);
  });
  it('gives up (false, no push) when the rotation never lands', async () => {
    const d = deps([{ k: ['DA', 'DB'], latestEstSn: 4, memberKey: 'DB2' }]);
    await expect(pushHistoryWhenSigner('EGRP', d, { attempts: 3, intervalMs: 1 })).resolves.toBe(false);
    expect(d.pushHistory).not.toHaveBeenCalled();
  });
  it('a failing sync is retried, not fatal', async () => {
    const sync = vi.fn().mockRejectedValueOnce(new Error('GroupBehind')).mockResolvedValue(undefined);
    const d = deps([{ k: ['DA'], latestEstSn: 0, memberKey: 'DA' }], { sync });
    await expect(pushHistoryWhenSigner('EGRP', d, { attempts: 3, intervalMs: 1 })).resolves.toBe(true);
    expect(d.pushHistory).toHaveBeenCalledTimes(1);
  });
  it('never rejects: a failing push resolves false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps([{ k: ['DA'], latestEstSn: 0, memberKey: 'DA' }], { pushHistory: async () => { throw new Error('boom'); } });
    await expect(pushHistoryWhenSigner('EGRP', d)).resolves.toBe(false);
    warn.mockRestore();
  });
});
