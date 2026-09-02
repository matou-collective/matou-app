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
