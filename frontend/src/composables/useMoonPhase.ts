import { ref } from 'vue';

// Moon phase data returned by the maramataka API. The API serves cultural
// content (day name, energy, description of the Māori lunar calendar), not a
// pure date calculation — so it is fetched, never computed locally.
export interface MoonData {
  date: string;
  lunar_day: number;
  name: string;
  energy: 'low' | 'medium' | 'high';
  description: string;
  moon_circle: string;
}

// Lifecycle of the moon-phase lookup. A terminal failure must collapse to
// 'unavailable' (hidden) rather than leaving the header on a permanent
// "Loading moon phase..." string — the external maramataka host is unreachable
// on the Android WebView (cleartext / network-security-config) and on the test
// stack. See issue #122.
export type MoonPhaseState = 'loading' | 'loaded' | 'unavailable';

export const MARAMATAKA_API_URL = 'https://maramataka-api.matou.nz/';

export function useMoonPhase() {
  const moonData = ref<MoonData | null>(null);
  const moonPhaseState = ref<MoonPhaseState>('loading');

  async function fetchMoonPhase() {
    try {
      const response = await fetch(MARAMATAKA_API_URL);
      if (response.ok) {
        moonData.value = (await response.json()) as MoonData;
        moonPhaseState.value = 'loaded';
      } else {
        // Non-2xx: log for diagnostics, then hide the moon line.
        console.error('Failed to fetch moon phase data');
        moonPhaseState.value = 'unavailable';
      }
    } catch (error) {
      // Network failure (blocked host, offline, cleartext block): log and hide.
      console.error('Error fetching moon phase:', error);
      moonPhaseState.value = 'unavailable';
    }
  }

  return { moonData, moonPhaseState, fetchMoonPhase };
}
