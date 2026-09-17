/**
 * Real-Android harness for e2e specs: boots (or adopts) an emulator/device,
 * tunnels the local test stack to it, installs the test-mode APK fresh, and
 * hands back a Playwright `Page` bound to the app's WebView.
 *
 * Everything the app talks to is reached as `localhost:<port>` from the device
 * through `adb reverse` — exactly what the WebView cleartext policy and the
 * config server's localhost URLs need (docs/mobile/ANDROID.md). The APK must
 * therefore be a TEST build:
 *
 *   cd backend && make build-android-aar
 *   VITE_ENV=test VITE_PROD_CONFIG_URL=http://localhost:4904 \
 *     VITE_TEST_CONFIG_URL=http://localhost:4904 scripts/android/build-apk.sh
 *
 * Env knobs:
 *   MATOU_ANDROID_APK     APK path (default: the build-apk.sh debug output)
 *   MATOU_ANDROID_AVD     AVD to boot when no device is attached (default: matou)
 *   MATOU_ANDROID_SERIAL  pin one device when several are attached
 *   MATOU_ANDROID_HEADED  =1 to show the emulator window
 *   ANDROID_SDK_ROOT / ANDROID_HOME (default: ~/.matou-android/sdk)
 */
import { _android as android } from '@playwright/test';
import type { AndroidDevice, Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configAdminToken } from './keri-testnet';

export const APP_ID = 'nz.matou.app';
const TEST_CONFIG_SERVER_URL = 'http://localhost:4904';

// KERIA (4901-4903) + config server (4904), the vLEI schema server (8723), the
// live witnesses (6642-6647) and the any-sync nodes (2001-2006).
const REVERSE_PORTS = [
  4901, 4902, 4903, 4904, 8723, 6642, 6643, 6644, 6645, 6646, 6647, 2001, 2002, 2003, 2004, 2005,
  2006,
];

const SDK_ROOT =
  process.env.ANDROID_SDK_ROOT ??
  process.env.ANDROID_HOME ??
  path.join(os.homedir(), '.matou-android', 'sdk');
const ADB = path.join(SDK_ROOT, 'platform-tools', 'adb');
const EMULATOR = path.join(SDK_ROOT, 'emulator', 'emulator');

export const DEFAULT_APK = path.resolve(
  __dirname,
  '../../../dist/capacitor/android/apk/debug/app-debug.apk',
);

const BUILD_HINT =
  'Build a TEST-mode APK first:\n' +
  '  cd backend && make build-android-aar\n' +
  '  VITE_ENV=test VITE_PROD_CONFIG_URL=http://localhost:4904 ' +
  'VITE_TEST_CONFIG_URL=http://localhost:4904 scripts/android/build-apk.sh';

export interface AndroidApp {
  serial: string;
  device: AndroidDevice;
  page: Page;
  /** `adb logcat -d` for the embedded Go backend — for failure messages. */
  backendLog: () => string;
  /** Closes the Playwright connection; kills the emulator only if we booted it. */
  close: () => Promise<void>;
}

function adb(serial: string | null, args: string[], timeoutMs = 120_000): string {
  const full = serial ? ['-s', serial, ...args] : args;
  return execFileSync(ADB, full, { encoding: 'utf-8', timeout: timeoutMs });
}

function attachedSerials(): string[] {
  return adb(null, ['devices'])
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[1] === 'device')
    .map((p) => p[0]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The APK must point at the local test config server, or the phone would
 *  silently join the PRODUCTION network. Checked before anything is installed. */
function assertTestApk(apk: string): void {
  if (!fs.existsSync(apk)) throw new Error(`APK not found at ${apk}.\n${BUILD_HINT}`);
  const raw = execFileSync('unzip', ['-p', apk, 'assets/capacitor.config.json'], {
    encoding: 'utf-8',
  });
  const cfg = JSON.parse(raw) as { plugins?: { MatouBackend?: { configServerUrl?: string } } };
  const url = cfg.plugins?.MatouBackend?.configServerUrl;
  if (url !== TEST_CONFIG_SERVER_URL) {
    throw new Error(
      `APK at ${apk} bakes configServerUrl=${url ?? '(none)'}, expected ${TEST_CONFIG_SERVER_URL}.\n${BUILD_HINT}`,
    );
  }
}

const adminAuth = () => ({
  Authorization: `Bearer ${process.env.CONFIG_ADMIN_TOKEN || configAdminToken}`,
});

/**
 * Make the e2e org visible to the phone.
 *
 * The e2e suite keeps its org in the config server's TEST slot, selected by an
 * `X-Test-Config: true` header. The phone cannot send it: on Capacitor the
 * WebView never talks to the config server, the embedded backend fetches org
 * config server-side (#265), and cmd/mobile always runs that backend as
 * Env=production — which sends no test header. Without this the app boots to
 * "org not configured" and redirects to /setup.
 *
 * The test config server's DEFAULT slot is otherwise unused (dev has its own
 * container on 3904), so copy the test org into it for the run and remove it
 * again in close().
 */
async function mirrorTestOrgToDefaultSlot(): Promise<void> {
  const url = `${TEST_CONFIG_SERVER_URL}/api/config`;
  const src = await fetch(url, { headers: { 'X-Test-Config': 'true' } });
  if (!src.ok) {
    throw new Error(`no test org on the config server (GET ${url} → ${src.status}); run org-setup first`);
  }
  const org = await src.text();
  await fetch(url, { method: 'DELETE', headers: adminAuth() }); // 404 when empty
  const put = await fetch(url, {
    method: 'POST',
    headers: { ...adminAuth(), 'Content-Type': 'application/json' },
    body: org,
  });
  if (!put.ok) throw new Error(`mirroring the test org failed: ${put.status} ${await put.text()}`);
}

async function unmirrorTestOrg(): Promise<void> {
  await fetch(`${TEST_CONFIG_SERVER_URL}/api/config`, {
    method: 'DELETE',
    headers: adminAuth(),
  }).catch(() => undefined);
}

async function bootEmulator(): Promise<{ serial: string; proc: ChildProcess }> {
  const avd = process.env.MATOU_ANDROID_AVD ?? 'matou';
  if (!fs.existsSync(EMULATOR)) {
    throw new Error(
      `No Android device attached and no emulator at ${EMULATOR}. ` +
        'Run scripts/android/setup-toolchain.sh or attach a device.',
    );
  }
  const args = ['-avd', avd, '-no-audio', '-no-boot-anim', '-no-snapshot-save'];
  if (!process.env.MATOU_ANDROID_HEADED) args.push('-no-window', '-gpu', 'swiftshader_indirect');
  console.log(`[android] booting emulator ${avd}…`);
  const proc = spawn(EMULATOR, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ANDROID_SDK_ROOT: SDK_ROOT },
  });
  proc.unref();

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`emulator exited early (code ${proc.exitCode})`);
    const serial = attachedSerials().find((s) => s.startsWith('emulator-'));
    if (serial) {
      const booted = adb(serial, ['shell', 'getprop', 'sys.boot_completed']).trim();
      if (booted === '1') return { serial, proc };
    }
    await sleep(3_000);
  }
  throw new Error(`emulator ${avd} did not finish booting in 4 min`);
}

/**
 * Attach to the app's WebView and make sure the page SURVIVES. On a just-booted
 * emulator the devtools socket is up before the WebView has settled, and the
 * page Playwright grabbed a moment earlier gets closed under it. Playwright
 * caches a device's WebViews, so re-asking the same AndroidDevice only hands
 * the dead page back — each retry therefore opens a FRESH device connection.
 */
async function attachStablePage(serial: string): Promise<{ device: AndroidDevice; page: Page }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const device = (await android.devices()).find((d) => d.serial() === serial);
    if (!device) throw new Error(`Playwright cannot see android device ${serial}`);
    device.setDefaultTimeout(60_000);
    try {
      const webView = await device.webView({ pkg: APP_ID }, { timeout: 120_000 });
      const page = await webView.page();
      await sleep(8_000);
      if (!page.isClosed()) {
        await page.evaluate(() => document.readyState);
        return { device, page };
      }
      lastError = new Error('WebView page closed right after attach');
    } catch (e) {
      lastError = e;
    }
    console.log(`[android] WebView attach ${attempt}/5 did not hold (${lastError}); retrying`);
    await device.close().catch(() => undefined);
    // `pidof` exits 1 (→ throws) when the app is not running.
    let running = false;
    try {
      running = !!adb(serial, ['shell', 'pidof', APP_ID]).trim();
    } catch {
      /* not running */
    }
    if (!running) launchApp(serial);
  }
  throw new Error(`could not attach to a stable ${APP_ID} WebView: ${lastError}`);
}

function launchApp(serial: string): void {
  adb(serial, ['shell', 'monkey', '-p', APP_ID, '-c', 'android.intent.category.LAUNCHER', '1']);
}

/**
 * Bring up a device with a FRESH install of the test APK and return a Page on
 * its WebView, sitting wherever the app's cold boot lands (the splash once an
 * org exists).
 */
export async function startAndroidApp(): Promise<AndroidApp> {
  const apk = process.env.MATOU_ANDROID_APK ?? DEFAULT_APK;
  assertTestApk(apk);

  adb(null, ['start-server']);
  let emulatorProc: ChildProcess | undefined;
  let serial = process.env.MATOU_ANDROID_SERIAL ?? attachedSerials()[0];
  if (!serial) {
    const booted = await bootEmulator();
    serial = booted.serial;
    emulatorProc = booted.proc;
  }
  const killEmulatorIfOurs = () => {
    if (!emulatorProc) return;
    try {
      adb(serial, ['emu', 'kill']);
    } catch {
      /* already gone */
    }
  };

  let device: AndroidDevice;
  let page: Page;
  try {
    console.log(`[android] using device ${serial}`);

    for (const p of REVERSE_PORTS) adb(serial, ['reverse', `tcp:${p}`, `tcp:${p}`]);

    await mirrorTestOrgToDefaultSlot();

    // Uninstall first: `install -r` keeps the previous run's identity + any-sync
    // store, and fails SILENTLY on a signature mismatch, leaving a stale build.
    try {
      adb(serial, ['uninstall', APP_ID]);
    } catch {
      /* not installed */
    }
    const installed = adb(serial, ['install', apk], 300_000);
    if (!/Success/.test(installed)) throw new Error(`adb install failed:\n${installed}`);

    adb(serial, ['logcat', '-c']);
    launchApp(serial);

    ({ device, page } = await attachStablePage(serial));
  } catch (e) {
    // Never leak an emulator we booted: the caller has no handle to close yet.
    await unmirrorTestOrg();
    killEmulatorIfOurs();
    throw e;
  }

  return {
    serial,
    device,
    page,
    backendLog: () => {
      try {
        return adb(serial, ['logcat', '-d', '-s', 'GoLog:*', 'MatouBackend:*']);
      } catch (e) {
        return `(logcat failed: ${e})`;
      }
    },
    close: async () => {
      await device.close().catch(() => undefined);
      await unmirrorTestOrg();
      killEmulatorIfOurs();
    },
  };
}
