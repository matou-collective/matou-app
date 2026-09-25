import type { KitBuild } from 'src/kit/types';

// The electron-builder `builder` block, derived from kit.build.json (generated
// by apply-kit). Keeping this here — rather than inline in quasar.config.ts —
// lets a unit test assert the mapping without booting Quasar. See Matou/coa
// ADR 0004.
export function electronBuilderConfig(kit: KitBuild) {
  const v = '${version}',
    // ${os} not ${platform}: electron-builder renders ${platform} as the
    // Node process.platform value (darwin/win32), so installer names would be
    // matou-1.0.0-darwin-x64.dmg / -win32.exe. ${os} gives mac/linux/win —
    // the names COA publishes on community pages (proven in Matou/coa#80).
    p = '${os}',
    a = '${arch}',
    e = '${ext}';
  return {
    appId: kit.appId,
    productName: kit.productName,
    // Force the packaged app.asar package.json `name` to the kit's
    // executableName. Chromium/Electron derives the window class from this
    // `name`: on X11 it is the WM_CLASS, and on native Wayland it is the xdg
    // `app_id` — the only thing GNOME can match a Wayland window to its
    // .desktop file by (StartupWMClass is X11-only and never applies). Without
    // this the packaged `name` stays "matou-frontend", so the app_id never
    // equals the installed <executableName>.desktop and the launcher falls back
    // to the generic gear icon instead of the community icon (#617). productName
    // must NOT be used here — it stays "Matou" for the userData path (see
    // kit-paths.ts) and is diacritic-folded, not a valid lowercase class.
    extraMetadata: { name: kit.executableName },
    artifactName: `${kit.artifactBase}-${v}-${p}.${e}`,
    afterPack: './build/afterPack.cjs',
    extraResources: [
      { from: '../backend/bin/', to: 'backend/' },
      { from: 'src-electron/icons/', to: 'icons/' },
    ],
    publish: kit.publish,
    mac: {
      target: ['dmg'],
      artifactName: `${kit.artifactBase}-${v}-${p}-${a}.${e}`,
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      icon: 'src-electron/icons/icon.png',
    },
    linux: {
      target: 'AppImage',
      icon: 'src-electron/icons',
      category: 'Network',
      executableName: kit.executableName,
      executableArgs: ['--no-sandbox'],
    },
    win: {
      target: 'nsis',
      icon: 'src-electron/icons/icon.png',
    },
  };
}
