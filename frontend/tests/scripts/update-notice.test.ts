import { describe, it, expect, vi } from 'vitest';
import {
  checkForUpdate,
  noticeTarget,
  pickUpdate,
  readDismissed,
  statusUrl,
  writeDismissed,
} from '../../src/lib/updateNotice';

const ASSETS = {
  'mac-arm64': 'https://coa.matou.nz/dl/s/v5/s-0.8.5-build.5-mac-arm64.dmg',
  'mac-x64': 'https://coa.matou.nz/dl/s/v5/s-0.8.5-build.5-mac-x64.dmg',
  android: 'https://coa.matou.nz/dl/s/v5/s-0.8.5-build.5-android.apk',
};
const ready = (build: unknown, assets: unknown = ASSETS) => ({ state: 'ready', build, assets });

describe('noticeTarget', () => {
  it('is Mac by architecture, or Android, and only for a Coa build', () => {
    expect(noticeTarget('s', { electronPlatform: 'darwin', electronArch: 'arm64' })).toBe('mac-arm64');
    expect(noticeTarget('s', { electronPlatform: 'darwin', electronArch: 'x64' })).toBe('mac-x64');
    expect(noticeTarget('s', { capacitorPlatform: 'android' })).toBe('android');
  });
  it('is nothing where the updater (or the Play Store) already serves', () => {
    expect(noticeTarget('s', { electronPlatform: 'win32', electronArch: 'x64' })).toBeNull();
    expect(noticeTarget('s', { electronPlatform: 'linux', electronArch: 'x64' })).toBeNull();
    expect(noticeTarget('s', { electronPlatform: 'darwin', electronArch: 'ia32' })).toBeNull();
    expect(noticeTarget('s', { capacitorPlatform: 'ios' })).toBeNull();
    expect(noticeTarget('s', {})).toBeNull();
    expect(noticeTarget('matou', { electronPlatform: 'darwin', electronArch: 'arm64' })).toBeNull();
    expect(noticeTarget('matou', { capacitorPlatform: 'android' })).toBeNull();
  });
});

describe('pickUpdate', () => {
  it('offers a newer ready build for this platform', () => {
    expect(pickUpdate(ready(5), 4, 'mac-arm64', null)).toEqual({ build: 5, url: ASSETS['mac-arm64'] });
    expect(pickUpdate(ready(5), 4, 'mac-x64', null)).toEqual({ build: 5, url: ASSETS['mac-x64'] });
    expect(pickUpdate(ready(5), 4, 'android', null)).toEqual({ build: 5, url: ASSETS.android });
  });
  it('offers nothing for the same or an older build', () => {
    expect(pickUpdate(ready(4), 4, 'android', null)).toBeNull();
    expect(pickUpdate(ready(3), 4, 'android', null)).toBeNull();
  });
  it('offers nothing while the community is not ready', () => {
    for (const state of ['building', 'failed', 'page-ready', undefined])
      expect(pickUpdate({ state, build: 9, assets: ASSETS }, 4, 'android', null), String(state)).toBeNull();
  });
  it('offers nothing for a malformed status', () => {
    for (const bad of [null, 'html', 42, [], {}, ready('5'), ready(5.5), ready(-1), ready(5, null), ready(5, 'x'), ready(5, { android: 7 }), ready(5, { android: 'not a url' }), ready(5, { android: 'http://coa.matou.nz/x.apk' })])
      expect(pickUpdate(bad, 4, 'android', null), JSON.stringify(bad)).toBeNull();
  });
  it('offers nothing when this platform has no installer in the build', () => {
    expect(pickUpdate(ready(5, { android: ASSETS.android }), 4, 'mac-arm64', null)).toBeNull();
  });
  it('stays quiet for a dismissed build and speaks again for a newer one', () => {
    expect(pickUpdate(ready(5), 4, 'android', 5)).toBeNull();
    expect(pickUpdate(ready(6), 4, 'android', 5)).toEqual({ build: 6, url: ASSETS.android });
  });
});

describe('dismissed build storage', () => {
  it('round-trips a build number', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(readDismissed(s)).toBeNull();
    writeDismissed(s, 7);
    expect(readDismissed(s)).toBe(7);
  });
  it('treats junk, a missing store, or a throwing store as nothing dismissed', () => {
    expect(readDismissed({ getItem: () => 'seven' })).toBeNull();
    expect(readDismissed(undefined)).toBeNull();
    expect(readDismissed({ getItem: () => { throw new Error('denied'); } })).toBeNull();
    expect(() => writeDismissed({ setItem: () => { throw new Error('denied'); } }, 7)).not.toThrow();
    expect(() => writeDismissed(undefined, 7)).not.toThrow();
  });
});

describe('checkForUpdate', () => {
  it('reads the community status document', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(ready(5)), { status: 200 }));
    expect(await checkForUpdate({ slug: 's', ownBuild: 4, target: 'android', dismissedBuild: null, fetchImpl })).toEqual({ build: 5, url: ASSETS.android });
    expect(fetchImpl.mock.calls[0][0]).toBe(statusUrl('s'));
    expect(statusUrl('s')).toBe('https://coa.matou.nz/c/s/status.json');
  });
  it('is silent on a network error, a non-200, or a body that is not JSON', async () => {
    const quiet = { slug: 's', ownBuild: 4, target: 'android' as const, dismissedBuild: null };
    expect(await checkForUpdate({ ...quiet, fetchImpl: vi.fn().mockRejectedValue(new TypeError('offline')) })).toBeNull();
    expect(await checkForUpdate({ ...quiet, fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 404 })) })).toBeNull();
    expect(await checkForUpdate({ ...quiet, fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })) })).toBeNull();
  });
});
