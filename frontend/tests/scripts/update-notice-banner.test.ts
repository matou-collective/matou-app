// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('src/generated/kit', () => ({ KIT: { slug: 's', build: 4 } }));
vi.mock('src/lib/capacitor', () => ({ getCapacitorPlatform: () => 'android', isCapacitor: () => true }));

const { default: UpdateNoticeBanner } = await import('../../src/components/base/UpdateNoticeBanner.vue');

const URL_5 = 'https://coa.matou.nz/dl/s/v5/s-0.8.5-build.5-android.apk';
const status = (build: number) => new Response(JSON.stringify({ state: 'ready', build, assets: { android: URL_5 } }), { status: 200 });

// Node 25 ships its own `localStorage` global, which shadows happy-dom's and has no
// methods without --localstorage-file; stand in a plain in-memory Storage.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  };
}

describe('UpdateNoticeBanner', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the notice for a newer build and opens its installer on Download', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(status(5)));
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const w = mount(UpdateNoticeBanner);
    await flushPromises();
    expect(w.text()).toContain('A new version is available.');
    await w.get('button.update-notice-download').trigger('click');
    expect(assign).toHaveBeenCalledWith(URL_5);
  });

  it('stays hidden when nothing newer is waiting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(status(4)));
    const w = mount(UpdateNoticeBanner);
    await flushPromises();
    expect(w.find('.update-notice-banner').exists()).toBe(false);
  });

  it('Dismiss hides it and remembers the build; a later check finds a newer build and shows it again', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(status(5)).mockResolvedValueOnce(status(5)).mockResolvedValueOnce(status(6));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(UpdateNoticeBanner);
    await flushPromises();
    await w.get('button.update-notice-dismiss').trigger('click');
    expect(w.find('.update-notice-banner').exists()).toBe(false);
    expect(localStorage.getItem('coa-update-dismissed-build')).toBe('5');

    vi.advanceTimersByTime(6 * 60 * 60 * 1000); // the same build again: still hidden
    await flushPromises();
    expect(w.find('.update-notice-banner').exists()).toBe(false);

    vi.advanceTimersByTime(6 * 60 * 60 * 1000); // build 6 lands
    await flushPromises();
    expect(w.text()).toContain('A new version is available.');
  });

  it('stops checking when it unmounts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(4));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(UpdateNoticeBanner);
    await flushPromises();
    w.unmount();
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
