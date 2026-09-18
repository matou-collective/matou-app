/**
 * Known sign-in sites the wallet remembers (idss spec #1492 stories 12/13/17,
 * ADR 0236 §5).
 *
 * The wallet keeps one entry per sign-in site it has met — `{url: {name,
 * firstMet, lastUsed}}` and nothing else about a sign-in (no per-event log,
 * spec story 17). The home community's site is seeded from the descriptor's
 * `signin.url` and marked as the home site so the approve card can show the
 * "your community" chip and never prompt first-contact for it (story 12).
 *
 * #531 (the approve card) uses this to mark the site line and to touch
 * `lastUsed` when a sign-in completes. #535 adds the first-contact prompt
 * (WS-A1) — `trust` records a site the member meets and agrees to — and the
 * "Sign-in sites you trust" management screen (WS-A3) — `rows` lists every
 * known door home-first and `forget` drops any but the home one.
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { secureStorage } from 'src/lib/secureStorage';

/** One remembered sign-in site (spec story 17). */
export interface KnownDoor {
  name: string;
  /** ISO-8601 timestamp first met. */
  firstMet: string;
  /** ISO-8601 timestamp last used. */
  lastUsed: string;
}

/** One remembered site as a management-list row (WS-A3, story 19). */
export interface KnownDoorRow extends KnownDoor {
  /** The site's normalized address (the key). */
  url: string;
  /** True → the home community's site; shown first and never Forgotten. */
  isHome: boolean;
}

const STORAGE_KEY = 'matou_known_doors';
/** The home site's URL, kept apart so it is never Forgotten (story 19). */
const HOME_KEY = 'matou_home_door';

/** Strip a trailing slash so `https://id.example.nz/` and `…nz` are one door. */
function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export const useKnownDoorsStore = defineStore('knownDoors', () => {
  const doors = ref<Record<string, KnownDoor>>({});
  const homeUrl = ref<string>('');
  let loaded = false;

  /** Load the persisted doors once (idempotent). */
  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await secureStorage.getItem(STORAGE_KEY);
      if (raw) doors.value = JSON.parse(raw) as Record<string, KnownDoor>;
    } catch {
      doors.value = {};
    }
    homeUrl.value = (await secureStorage.getItem(HOME_KEY)) ?? '';
  }

  async function persist(): Promise<void> {
    await secureStorage.setItem(STORAGE_KEY, JSON.stringify(doors.value));
  }

  /**
   * Seed the home site from the descriptor's `signin.url` (story 12). The home
   * site is pre-trusted from boot; re-seeding on a descriptor refresh keeps its
   * name current without disturbing `firstMet`.
   */
  async function seedHome(url: string, name: string): Promise<void> {
    await load();
    const key = normalize(url);
    if (!key) return;
    homeUrl.value = key;
    await secureStorage.setItem(HOME_KEY, key);
    const now = new Date().toISOString();
    const existing = doors.value[key];
    doors.value[key] = {
      name: name || existing?.name || 'your community',
      firstMet: existing?.firstMet ?? now,
      lastUsed: existing?.lastUsed ?? now,
    };
    await persist();
  }

  /**
   * Trust a sign-in site the member has just met at the first-contact prompt
   * (WS-A1, story 11/19). Records `firstMet`/`lastUsed` now; trusting a site the
   * wallet already knows only refreshes its name, never its `firstMet`.
   */
  async function trust(url: string, name: string): Promise<void> {
    await load();
    const key = normalize(url);
    if (!key) return;
    const now = new Date().toISOString();
    const existing = doors.value[key];
    doors.value[key] = {
      name: name || existing?.name || key,
      firstMet: existing?.firstMet ?? now,
      lastUsed: existing?.lastUsed ?? now,
    };
    await persist();
  }

  /**
   * Forget a trusted site (WS-A3, story 19). The home site is never Forgotten;
   * Forget removes only the local record and tells the site nothing, so the next
   * code naming that address shows the first-contact prompt again. Returns false
   * when asked to forget the home site or a site the wallet does not know.
   */
  async function forget(url: string): Promise<boolean> {
    await load();
    const key = normalize(url);
    if (!key || key === homeUrl.value) return false;
    if (!(key in doors.value)) return false;
    delete doors.value[key];
    await persist();
    return true;
  }

  /** True when `url` is the home community's sign-in site (story 12/13). */
  function isHome(url: string): boolean {
    return !!homeUrl.value && normalize(url) === homeUrl.value;
  }

  /**
   * The trusted sites as management-list rows, the home site first and the rest
   * by name (WS-A3, story 19). Reactive, so the list updates as sites are
   * trusted or Forgotten.
   */
  const rows = computed<KnownDoorRow[]>(() => {
    return Object.entries(doors.value)
      .map(([url, door]) => ({ url, ...door, isHome: url === homeUrl.value }))
      .sort((a, b) => {
        if (a.isHome !== b.isHome) return a.isHome ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  });

  /** True when `url` is a site the wallet already knows (home or trusted). */
  function isKnown(url: string): boolean {
    return normalize(url) in doors.value;
  }

  /** Read a remembered door, or `undefined`. */
  function get(url: string): KnownDoor | undefined {
    return doors.value[normalize(url)];
  }

  /**
   * Touch `lastUsed` on a completed sign-in (story 17). Only an already-known
   * door is touched — a first sign-in against an unknown door is trusted via
   * the first-contact prompt (a separate ticket), not here.
   */
  async function touch(url: string): Promise<void> {
    await load();
    const key = normalize(url);
    const entry = doors.value[key];
    if (!entry) return;
    entry.lastUsed = new Date().toISOString();
    await persist();
  }

  return { doors, homeUrl, rows, load, seedHome, trust, forget, isHome, isKnown, get, touch };
});
