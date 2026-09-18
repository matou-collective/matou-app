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
 * `lastUsed` when a sign-in completes. The first-contact prompt (WS-A1) and the
 * "Sign-in sites you trust" management screen (WS-A3) are separate tickets;
 * this store is shaped for them but exposes only what the card needs today.
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { secureStorage } from 'src/lib/secureStorage';

/** One remembered sign-in site (spec story 17). */
export interface KnownDoor {
  name: string;
  /** ISO-8601 timestamp first met. */
  firstMet: string;
  /** ISO-8601 timestamp last used. */
  lastUsed: string;
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

  /** True when `url` is the home community's sign-in site (story 12/13). */
  function isHome(url: string): boolean {
    return !!homeUrl.value && normalize(url) === homeUrl.value;
  }

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

  return { doors, homeUrl, load, seedHome, isHome, isKnown, get, touch };
});
