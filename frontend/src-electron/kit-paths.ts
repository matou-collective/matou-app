import path from 'path';
import type { KitBuild } from 'src/kit/types';

// Per-kit state isolation. electron-builder names the packaged app — and thus
// Electron's default userData dir — after productName, but that naming only
// lands in the platform bundle metadata. At runtime app.getName() falls back to
// the asar package.json name ("Matou"), so EVERY kit-branded fork silently
// shares the stock Matou userData dir: identity (KERI keys), the bundled
// backend's data dir, the secure store and the cached any-sync config all bleed
// between apps (issue #344). Deriving the dir name here and forcing it via
// app.setPath('userData', …) before the path is first read isolates each kit.
//
// The dir name IS productName (already diacritic-folded to ASCII by apply-kit,
// see buildInfo() — the packaging identity must stay ASCII). Stock Matou's
// productName is "Matou", so stock installs keep their existing ~/.config/Matou
// path and no current user's data is orphaned.

/**
 * Directory name for the app's userData root, derived from the applied kit.
 * Falls back to "Matou" (the stock path) if productName is somehow empty, so a
 * malformed kit can never collapse to a bare appData root.
 */
export function kitUserDataDirName(kitBuild: Pick<KitBuild, 'productName'>): string {
  return kitBuild.productName.trim() || 'Matou';
}

/**
 * Absolute userData root for the applied kit, under Electron's appData base
 * (~/.config on Linux, ~/Library/Application Support on macOS, %APPDATA% on
 * Windows) — the same base Electron uses for the default userData path.
 */
export function kitUserDataPath(appDataDir: string, kitBuild: Pick<KitBuild, 'productName'>): string {
  return path.join(appDataDir, kitUserDataDirName(kitBuild));
}
