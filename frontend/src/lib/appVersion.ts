/**
 * One line naming the running app's version, for the bottom of Account
 * Settings (and anywhere else a member might read it back to support).
 *
 * The number comes from two places, depending on how the app was built:
 *   - Coa desktop builds stamp frontend/package.json as `<version>-build.<N>`
 *     (coa-builds `set_desktop_version`), so the build rides in the version.
 *   - Android keeps the plain versionName and carries N in the APK's
 *     versionCode, which the Capacitor App plugin reports as `build`.
 *   - A dev / browser / from-source run has neither, and shows just the version.
 */
import { version as packageVersion } from '../../package.json';
import { getAppPlugin, isCapacitor } from './capacitor';

const BUILD_SUFFIX = /^(.*?)-build\.(\d+)$/;

/** "Version 0.8.8 · build 19", or "Version 0.8.8" when no build number is known. */
export function formatAppVersion(version: string, nativeBuild?: string): string {
  const stamped = BUILD_SUFFIX.exec(version);
  const base = stamped ? stamped[1] : version;
  const build = stamped ? stamped[2] : nativeBuild?.trim() || '';
  return build ? `Version ${base} · build ${build}` : `Version ${base}`;
}

/**
 * The version line for this running app. Inside the Capacitor shell the App
 * plugin is asked once for the native build number; a refusal (an older shell,
 * a plugin that is not registered) degrades to the plain version, never throws.
 */
export async function describeAppVersion(version: string = packageVersion): Promise<string> {
  if (!isCapacitor()) return formatAppVersion(version);
  try {
    const info = await getAppPlugin()?.getInfo?.();
    return formatAppVersion(version, info?.build);
  } catch {
    return formatAppVersion(version);
  }
}
