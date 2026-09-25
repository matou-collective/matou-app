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
    //     the app name (productName, "Matou" on a Coa build) and the app_id
    //     never equals <executableName>, so GNOME finds no .desktop (#634).
    // productName must NOT be overridden here: the packaged package.json keeps
    // the source "Matou", which is the app NAME Electron's safeStorage keys the
    // Linux keyring secret on ("<app name> Safe Storage", application=<name>).
    // #641 set it to the kit's product name and v0.7.8 read a different keyring
    // secret, so every existing install lost its saved passcode, agent, identity
    // key and any-sync device key on upgrade (#644). The Wayland app_id comes
    // from desktopName above, so the icon does not need it. userData isolation
    // is forced separately from KIT_BUILD.productName in kit-paths.ts.
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
