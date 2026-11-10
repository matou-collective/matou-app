// @vitest-environment happy-dom
/**
 * The version line at the bottom of Account Settings. A member on their phone
 * asked "which build am I on?" and the only place the version showed was the
 * splash screen, gone in a second. So the profile form ends with one quiet line
 * naming the version — and, when the build carries one, the build number.
 *
 * Two sources, one line:
 *   - Coa desktop builds stamp frontend/package.json as `<version>-build.<N>`
 *     (coa-builds coa-build.sh set_desktop_version), so the number rides in the
 *     version string itself.
 *   - Android keeps the plain versionName and puts N in versionCode, which the
 *     Capacitor App plugin reports as `build`; the native shell is asked once.
 *   - A dev/browser/Electron-from-source run has neither: just the version.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeAppVersion, formatAppVersion } from '../../src/lib/appVersion';

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

function installCapacitor(info: { version: string; build: string } | Error) {
  (window as unknown as { Capacitor: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      App: {
        getInfo: () => (info instanceof Error ? Promise.reject(info) : Promise.resolve(info)),
      },
    },
  };
}

describe('formatAppVersion', () => {
  it('splits a Coa desktop version into version + build', () => {
    expect(formatAppVersion('0.8.8-build.19')).toBe('Version 0.8.8 · build 19');
  });

  it('uses a native build number when the version string has none', () => {
    expect(formatAppVersion('0.8.8', '19')).toBe('Version 0.8.8 · build 19');
  });

  it('prefers the build stamped in the version string over the native one', () => {
    expect(formatAppVersion('0.8.8-build.19', '7')).toBe('Version 0.8.8 · build 19');
  });

  it('is just the version when there is no build number at all', () => {
    expect(formatAppVersion('0.8.8')).toBe('Version 0.8.8');
    expect(formatAppVersion('0.8.8', '')).toBe('Version 0.8.8');
    expect(formatAppVersion('0.8.8', undefined)).toBe('Version 0.8.8');
  });
});

describe('describeAppVersion', () => {
  it('reads the build number from the Capacitor App plugin on a phone', async () => {
    installCapacitor({ version: '0.8.8', build: '19' });
    expect(await describeAppVersion('0.8.8')).toBe('Version 0.8.8 · build 19');
  });

  it('falls back to the plain version when the plugin refuses', async () => {
    installCapacitor(new Error('no such plugin'));
    expect(await describeAppVersion('0.8.8')).toBe('Version 0.8.8');
  });

  it('never asks the shell outside Capacitor', async () => {
    expect(await describeAppVersion('0.8.8')).toBe('Version 0.8.8');
  });

  it('defaults to the version from package.json', async () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string };
    expect(await describeAppVersion()).toBe(formatAppVersion(pkg.version));
  });
});

describe('Account Settings shows the version line', () => {
  const page = readFileSync(join(__dirname, '../../src/pages/AccountSettingsPage.vue'), 'utf8');

  it('renders a data-test="app-version" footer fed by describeAppVersion', () => {
    expect(page).toContain('data-test="app-version"');
    expect(page).toContain("from 'src/lib/appVersion'");
    expect(page).toContain('describeAppVersion(');
  });
});
