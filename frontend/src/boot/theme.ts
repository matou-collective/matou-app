import { boot } from 'quasar/wrappers';
import { Dark } from 'quasar';
import { isCapacitor } from 'src/lib/platform';

/**
 * localStorage key for the persisted theme choice. Shared with the toggle in
 * DashboardPage.vue — keep in sync if that ever moves into a store.
 */
export const THEME_STORAGE_KEY = 'matou:theme';

export type ThemeChoice = 'dark' | 'light';

function loadStoredTheme(): ThemeChoice | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'dark' || raw === 'light' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Apply a theme to both the DOM (`.dark` class the design tokens key off)
 * and the Quasar Dark plugin (so q-components pick up their dark variants).
 */
export function applyTheme(isDark: boolean): void {
  document.documentElement.classList.toggle('dark', isDark);
  Dark.set(isDark);
}

export function persistTheme(choice: ThemeChoice): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(THEME_STORAGE_KEY, choice);
    }
  } catch {
    // Best-effort persistence; a full/blocked localStorage must not crash the app.
  }
}

/**
 * Resolve the theme to boot with: an explicit prior choice always wins,
 * otherwise default to dark on mobile (Capacitor) and light everywhere else
 * (Electron / browser).
 */
function resolveInitialTheme(): boolean {
  const stored = loadStoredTheme();
  if (stored) return stored === 'dark';
  return isCapacitor();
}

export default boot(() => {
  applyTheme(resolveInitialTheme());
});
