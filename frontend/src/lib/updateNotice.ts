/**
 * The Coa update notice (Matou/coa app-updates spec §4): a Coa build on macOS
 * (unsigned, so electron-updater cannot apply an update) or Android (sideloaded)
 * reads its community's public status document and offers the newer installer.
 * Pure decisions here; UpdateNoticeBanner.vue does the timing and the UI.
 * Windows and Linux Coa builds update themselves (electron-updater), and the
 * Mātou app has its own updater and the Play Store, so they get no notice.
 */

export type NoticeTarget = 'mac-arm64' | 'mac-x64' | 'android';
export interface NoticeEnv {
  electronPlatform?: string;
  electronArch?: string;
  capacitorPlatform?: string;
}
export interface AvailableUpdate {
  build: number;
  url: string;
}

export const COA_BASE = 'https://coa.matou.nz';
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DISMISSED_KEY = 'coa-update-dismissed-build';
const TIMEOUT_MS = 15_000;

export function statusUrl(slug: string): string {
  return `${COA_BASE}/c/${slug}/status.json`;
}

export function noticeTarget(slug: string, env: NoticeEnv): NoticeTarget | null {
  if (slug === 'matou') return null;
  if (env.electronPlatform === 'darwin') {
    if (env.electronArch === 'arm64') return 'mac-arm64';
    if (env.electronArch === 'x64') return 'mac-x64';
    return null;
  }
  return env.capacitorPlatform === 'android' ? 'android' : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function pickUpdate(
  status: unknown,
  ownBuild: number,
  target: NoticeTarget,
  dismissedBuild: number | null,
): AvailableUpdate | null {
  if (!isRecord(status) || status.state !== 'ready') return null;
  const build = status.build;
  if (typeof build !== 'number' || !Number.isInteger(build) || build <= ownBuild) return null;
  if (dismissedBuild !== null && build <= dismissedBuild) return null;
  if (!isRecord(status.assets)) return null;
  const url = status.assets[target];
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  return { build, url };
}

export function readDismissed(storage: Pick<Storage, 'getItem'> | undefined): number | null {
  try {
    const raw = storage?.getItem(DISMISSED_KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeDismissed(storage: Pick<Storage, 'setItem'> | undefined, build: number): void {
  try {
    storage?.setItem(DISMISSED_KEY, String(build));
  } catch {
    // A private window or blocked storage only means the notice may come back.
  }
}

export async function checkForUpdate(opts: {
  slug: string;
  ownBuild: number;
  target: NoticeTarget;
  dismissedBuild: number | null;
  fetchImpl?: typeof fetch;
}): Promise<AvailableUpdate | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(statusUrl(opts.slug), {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return pickUpdate(await res.json(), opts.ownBuild, opts.target, opts.dismissedBuild);
  } catch (err) {
    console.info('[UpdateNotice] check failed:', err);
    return null;
  }
}
