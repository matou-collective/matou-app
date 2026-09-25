/**
 * Linux .desktop entry generation for AppImage desktop integration (#532, #623).
 *
 * Kept out of electron-main.ts (which imports `electron` at module load) so the
 * generated content is unit-testable without an Electron runtime — same split
 * as kit-paths.ts.
 */

export interface DesktopEntryParams {
  /** Human-readable app name (from the kit brand). */
  name: string;
  /** Kit executable name — the .desktop basename and Icon/StartupWMClass key. */
  executableName: string;
  /** Absolute path to the running AppImage (`$APPIMAGE`). */
  appImagePath: string;
  /** Deep-link scheme this build claims (e.g. `matou`). */
  scheme: string;
}

/**
 * Build the `.desktop` file body for an AppImage install.
 *
 * The `MimeType=x-scheme-handler/<scheme>;` line is what makes the browser's
 * "Open with" dialog — and `xdg-mime` — able to route a `<scheme>://` sign-in
 * link to this app (#623). Without it `app.setAsDefaultProtocolClient` is a
 * no-op on Linux: it only takes effect when a registered .desktp file declares
 * the scheme.
 *
 * Known limit (not solved here, deliberate per the #532 ruling): every branded
 * kit claims the same `<scheme>://` — the links are minted as `matou://…`, so
 * they are not per-community. A machine with two community apps (or a community
 * app plus stock Mātou) hands the link to whichever registered its handler last.
 * Per-community schemes would be a separate ruling, since the IDSS bridge mints
 * the links.
 */
export function buildDesktopEntry({ name, executableName, appImagePath, scheme }: DesktopEntryParams): string {
  return `[Desktop Entry]
Name=${name}
Exec="${appImagePath}" %U
Terminal=false
Type=Application
Icon=${executableName}
StartupWMClass=${executableName}
Categories=Network;
MimeType=x-scheme-handler/${scheme};
Comment=${name} Community
`;
}

/** The MimeType declaration for a scheme, e.g. `x-scheme-handler/matou`. */
export function schemeHandlerMimeType(scheme: string): string {
  return `x-scheme-handler/${scheme}`;
}
