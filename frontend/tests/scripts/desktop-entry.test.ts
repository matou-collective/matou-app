/**
 * Linux AppImage .desktop entry generation (#623).
 *
 * The generated entry must declare the deep-link scheme via a
 * `MimeType=x-scheme-handler/<scheme>;` line — without it the browser's "Open
 * with" dialog (and xdg-mime) has no handler to offer for a matou:// sign-in
 * link, and app.setAsDefaultProtocolClient is a Linux no-op.
 */
import { describe, it, expect } from 'vitest';
import { buildDesktopEntry, schemeHandlerMimeType } from '../../src-electron/desktop-entry';

const params = {
  name: 'Whakatōhea',
  executableName: 'whakatohea-demo',
  appImagePath: '/home/ben/Apps/Whakatohea.AppImage',
  scheme: 'matou',
  iconPath: '/home/ben/.local/share/icons/hicolor/256x256/apps/whakatohea-demo.png',
};

describe('buildDesktopEntry (#623)', () => {
  it('declares the scheme handler so the browser can route matou:// links', () => {
    const entry = buildDesktopEntry(params);
    expect(entry).toContain('MimeType=x-scheme-handler/matou;');
  });

  it('carries the AppImage exec, icon and WM class keys', () => {
    const entry = buildDesktopEntry(params);
    expect(entry).toContain('[Desktop Entry]');
    expect(entry).toContain('Name=Whakatōhea');
    expect(entry).toContain('Exec="/home/ben/Apps/Whakatohea.AppImage" %U');
    // An ABSOLUTE icon path: GNOME Shell reads only the hicolor dirs that existed
    // when it started, and a first install creates them later, so a theme name
    // falls back to the gear until the next login (#651).
    expect(entry).toContain('Icon=/home/ben/.local/share/icons/hicolor/256x256/apps/whakatohea-demo.png');
    expect(entry).toContain('StartupWMClass=whakatohea-demo');
  });

  it('uses the given scheme in the MimeType line', () => {
    const entry = buildDesktopEntry({ ...params, scheme: 'other' });
    expect(entry).toContain('MimeType=x-scheme-handler/other;');
    expect(entry).not.toContain('x-scheme-handler/matou');
  });
});

describe('schemeHandlerMimeType', () => {
  it('formats the xdg-mime type for a scheme', () => {
    expect(schemeHandlerMimeType('matou')).toBe('x-scheme-handler/matou');
  });
});
