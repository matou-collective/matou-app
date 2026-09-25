import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { electronBuilderConfig } from '../../src-electron/kit-builder-config';

describe('electron-builder config from kit.build.json', () => {
  it('maps the default kit to upstream values', () => {
    const c = electronBuilderConfig(JSON.parse(readFileSync(join(__dirname, '../../kit.build.json'), 'utf8')));
    expect(c.appId).toBe('org.matou.app');
    expect(c.productName).toBe('Matou'); // diacritic-folded by apply-kit — packaging name must stay ASCII (userData path!)
    expect(c.artifactName).toBe('matou-${version}-${os}.${ext}');
    expect(c.mac.artifactName).toBe('matou-${version}-${os}-${arch}.${ext}');
    expect(c.linux.executableName).toBe('matou');
    // The packaged package.json `name` — what Chromium derives the X11 WM_CLASS
    // and the Wayland app_id from — must be the executableName, NOT the source
    // "matou-frontend", so a running window matches the installed
    // <executableName>.desktop and shows the community icon (#617).
    expect(c.extraMetadata.name).toBe('matou');
    // desktopName is what Chromium turns into the Wayland xdg app_id at startup
    // (via CHROME_DESKTOP); without it the app_id falls back to productName and
    // GNOME can't match the window to matou.desktop (#634).
    expect(c.extraMetadata.desktopName).toBe('matou.desktop');
    // Never override productName in the packaged asar package.json. On Linux,
    // Electron's safeStorage keys the keyring secret on the app name
    // (productName); renaming it orphans every existing install's encrypted
    // state — passcode, agent AID, identity key, the any-sync peer key — on
    // upgrade (#644, the v0.7.8/#641 regression). The asar keeps the source
    // "Matou" for every build only while this field is absent.
    expect(c.extraMetadata).not.toHaveProperty('productName');
    expect(c.publish).toEqual([{ provider: 'github', owner: 'matou-collective', repo: 'matou-app', releaseType: 'release' }]);
  });
  it('maps a community kit to coa values and publish null', () => {
    const c = electronBuilderConfig({ appId: 'org.matou.coa.x-y', productName: 'X Y', artifactBase: 'x-y', executableName: 'x-y', androidApplicationId: 'org.matou.coa.x-y', urlScheme: 'org.matou.coa.x-y', publish: null, updates: false, primaryColour: '#000000', backgroundColour: '#000000' });
    expect(c.publish).toBeNull();
    expect(c.artifactName).toBe('x-y-${version}-${os}.${ext}');
    // A branded kit's Wayland app_id / X11 WM_CLASS derives from executableName,
    // not "matou-frontend" — this is what lets its dock icon resolve (#617).
    expect(c.extraMetadata.name).toBe('x-y');
    // The Wayland app_id must resolve to <executableName>.desktop, not the
    // productName-derived fallback, so the branded dock icon shows (#634).
    expect(c.extraMetadata.desktopName).toBe('x-y.desktop');
    // A community kit must NOT override productName either — the keyring secret
    // stays under `application=Matou` across upgrades, so no install loses its
    // encrypted state (#644).
    expect(c.extraMetadata).not.toHaveProperty('productName');
  });
});
