import { describe, it, expect, vi } from 'vitest';
import { createStewardReadiness } from 'src/composables/useStewardReadiness';
import { GroupBehind, NotJoined, StewardRefusal, userFacingMessage } from 'src/lib/keri/steward/errors';

const deps = (over: Partial<Parameters<typeof createStewardReadiness>[0]> = {}) => ({
  resolveGroup: vi.fn(async () => 'EGRP'),
  resolveRegistry: vi.fn(async () => 'EREG'),
  groupMemberAid: vi.fn(async () => 'EME'),
  syncGroup: vi.fn(async () => {}),
  adoptRegistry: vi.fn(async () => {}),
  pushHistory: vi.fn(async () => {}),
  ...over,
});

describe('createStewardReadiness', () => {
  it('is ready once joined, synced and adopted, then pushes history', async () => {
    const d = deps();
    const r = createStewardReadiness(d);
    expect(r.ready.value).toBe(false);
    await expect(r.ensureReady()).resolves.toBe(true);
    expect(r.ready.value).toBe(true);
    expect(r.reason.value).toBeNull();
    expect(d.adoptRegistry).toHaveBeenCalledWith('EGRP', 'EREG');
    expect(d.pushHistory).toHaveBeenCalledWith('EGRP', 'EREG');
  });
  it('a not-yet-joined steward is blocked with the refusal userMessage (R4)', async () => {
    const r = createStewardReadiness(deps({ resolveGroup: async () => { throw new NotJoined('no group'); } }));
    await expect(r.ensureReady()).resolves.toBe(false);
    expect(r.reason.value).toBe(new NotJoined('x').userMessage);
  });
  it('a transient GroupBehind clears on the next check', async () => {
    const syncGroup = vi.fn().mockRejectedValueOnce(new GroupBehind('sn 3 < 4')).mockResolvedValue(undefined);
    const r = createStewardReadiness(deps({ syncGroup }));
    await r.ensureReady();
    expect(r.ready.value).toBe(false);
    expect(r.reason.value).toBe(new GroupBehind('x').userMessage);
    await r.ensureReady();
    expect(r.ready.value).toBe(true);
  });
  it('concurrent checks share one pass', async () => {
    const d = deps();
    const r = createStewardReadiness(d);
    await Promise.all([r.ensureReady(), r.ensureReady()]);
    expect(d.syncGroup).toHaveBeenCalledTimes(1);
  });
  it('recheck() only runs while not ready', async () => {
    const d = deps();
    const r = createStewardReadiness(d);
    await r.ensureReady();
    await r.recheck();
    expect(d.syncGroup).toHaveBeenCalledTimes(1);
  });
});

describe('userFacingMessage (R10)', () => {
  it('shows a StewardRefusal userMessage, not its detail', () => {
    expect(userFacingMessage(new StewardRefusal('detail', 'Plain words'))).toBe('Plain words');
  });
  it('falls back to the error message for other errors', () => {
    expect(userFacingMessage(new Error('boom'))).toBe('boom');
    expect(userFacingMessage('str')).toBe('str');
  });
});
