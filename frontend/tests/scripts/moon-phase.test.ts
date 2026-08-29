import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMoonPhase, MARAMATAKA_API_URL, type MoonData } from '../../src/composables/useMoonPhase';

const SAMPLE: MoonData = {
  date: '2026-08-28',
  lunar_day: 14,
  name: 'Ōturu',
  energy: 'high',
  description: 'A high-energy night in the Māori lunar calendar.',
  moon_circle: '🌕',
};

describe('useMoonPhase', () => {
  beforeEach(() => {
    // Silence the diagnostic console.error the failure paths emit.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts in the loading state with no data', () => {
    const { moonData, moonPhaseState } = useMoonPhase();
    expect(moonPhaseState.value).toBe('loading');
    expect(moonData.value).toBeNull();
  });

  it('resolves to loaded with the payload on a successful fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(SAMPLE) })
    );
    const { moonData, moonPhaseState, fetchMoonPhase } = useMoonPhase();
    await fetchMoonPhase();
    expect(fetch).toHaveBeenCalledWith(MARAMATAKA_API_URL);
    expect(moonPhaseState.value).toBe('loaded');
    expect(moonData.value).toEqual(SAMPLE);
  });

  // Regression for #122: the Android WebView blocks the external host, so the
  // fetch rejects. The state must collapse to 'unavailable' (hidden) rather
  // than staying on 'loading' forever.
  it('collapses to unavailable when the network fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { moonData, moonPhaseState, fetchMoonPhase } = useMoonPhase();
    await fetchMoonPhase();
    expect(moonPhaseState.value).toBe('unavailable');
    expect(moonPhaseState.value).not.toBe('loading');
    expect(moonData.value).toBeNull();
    expect(console.error).toHaveBeenCalled(); // still logged for diagnostics
  });

  it('collapses to unavailable on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const { moonPhaseState, fetchMoonPhase } = useMoonPhase();
    await fetchMoonPhase();
    expect(moonPhaseState.value).toBe('unavailable');
  });

  it('does not leave an unhandled rejection when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { fetchMoonPhase } = useMoonPhase();
    await expect(fetchMoonPhase()).resolves.toBeUndefined();
  });
});
