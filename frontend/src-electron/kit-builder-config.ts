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
    // Pin two fields into the packaged app.asar package.json so the running
    // window resolves to the installed <executableName>.desktop and shows the
    // community icon instead of the generic gear (#617, #634):
    //   • name → executableName. On X11 Chromium derives WM_CLASS from this,
    //     which StartupWMClass in the .desktop matches.
    //   • desktopName → <executableName>.desktop. On native Wayland GNOME
    //     matches a window to its .desktop by the xdg app_id, NOT WM_CLASS
    //     (StartupWMClass is X11-only). Chromium sets the Wayland app_id at
    //     startup from CHROME_DESKTOP, which it derives from this desktopName;
    //     app.setDesktopName() in electron-main runs too late to change the
    //     already-created toplevel's app_id. Without it Chromium falls back to
    //     the app name (productName, "Matou") and the app_id never equals
    //     <executableName>, so GNOME finds no .desktop (#634).
    //
    // Do NOT add `productName` here. The packaged asar package.json keeps the
    // source "Matou" for EVERY build, base or community kit, and it must stay
    // that way: on Linux, Electron's safeStorage encrypts with a keyring secret
    // stored under the app name (`application` attribute = productName). Every
    // install up to 0.7.7 keyed its secrets on `application=Matou`; overriding
    // productName to the kit name (v0.7.8, #641) made the app read a different
    // keyring entry, orphaning every existing install's encrypted state —
    // passcode, agent AID, identity key, and the any-sync peer key — on upgrade
    // (#644). Renaming this again re-breaks that; the guard test in
    // tests/scripts/kit-build-config.test.ts fails if productName reappears.
    // The Wayland dock icon does NOT need it — desktopName above drives the
    // app_id (#634) — and userData isolation is forced from KIT_BUILD.productName
    // in kit-paths.ts, not from this field.
    extraMetadata: {
      name: kit.executableName,
      desktopName: `${kit.executableName}.desktop`,
    },
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
