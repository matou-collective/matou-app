/**
 * QR scanning for linked-device sign-in (#473).
 *
 * Thin wrapper over `@capacitor-mlkit/barcode-scanning`, feature-detected off
 * `window.Capacitor.Plugins.BarcodeScanner` per the `src/lib/capacitor.ts`
 * doctrine (no `@capacitor/core` import). Two paths, per the spec:
 *
 *  - **Android, Google Code Scanner** (`scan()`): a Play-Services system UI
 *    that needs no CAMERA permission and no bundled model. Preferred.
 *  - **Fallback** (`startScan()` + `barcodeScanned` listener): the in-app
 *    scanner behind a transparent WebView; needs CAMERA permission, requested
 *    at tap time. Used on iOS and on Android devices without Play Services.
 *
 * The scan UI is device-only; emulators, e2e and dev use the paste fallback in
 * the screen, so this module is never exercised there.
 */
import {
  getBarcodeScannerPlugin,
  getCapacitorPlatform,
  type BarcodeScannerPlugin,
  type CameraPermissionState,
} from './capacitor';

/** QR only — we never want the scanner locking onto some other symbol. */
const QR_FORMAT = 'QR_CODE';

/** Thrown when scanning can't proceed; `reason` lets the screen tailor copy. */
export class ScanUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'unsupported' | 'permission-denied',
  ) {
    super(message);
    this.name = 'ScanUnavailableError';
  }
}

/** Whether a native scanner is present at all (so we can show the Scan button). */
export function isScannerAvailable(): boolean {
  return getBarcodeScannerPlugin() !== undefined;
}

/**
 * Open the camera and resolve with the scanned QR text, or `null` if the user
 * dismissed the scanner without scanning anything. Throws
 * {@link ScanUnavailableError} when no scanner is present or the camera
 * permission was denied.
 */
export async function scanPairingQr(): Promise<string | null> {
  const plugin = getBarcodeScannerPlugin();
  if (!plugin) {
    throw new ScanUnavailableError('No barcode scanner on this device', 'unsupported');
  }

  const isAndroid = getCapacitorPlatform() === 'android';
  if (isAndroid && typeof plugin.scan === 'function') {
    const viaGoogle = await tryGoogleScan(plugin);
    // `undefined` means the Google path was unavailable (no Play Services);
    // fall through to the permissioned in-app scanner. `null` is a real
    // user-dismissed result and is returned as-is.
    if (viaGoogle !== undefined) return viaGoogle;
  }

  return startScanFallback(plugin);
}

/**
 * Google Code Scanner path. Returns the scanned text, `null` when the user
 * dismissed it, or `undefined` when the path is unavailable on this device
 * (so the caller falls back to the in-app scanner).
 */
async function tryGoogleScan(plugin: BarcodeScannerPlugin): Promise<string | null | undefined> {
  try {
    if (typeof plugin.isGoogleBarcodeScannerModuleAvailable === 'function') {
      const { available } = await plugin.isGoogleBarcodeScannerModuleAvailable();
      if (!available) {
        // Kick off the one-time module install, but don't block this scan on
        // it; fall back to the in-app scanner this time.
        void plugin.installGoogleBarcodeScannerModule?.().catch(() => undefined);
        return undefined;
      }
    }
    const { barcodes } = await plugin.scan!({ formats: [QR_FORMAT] });
    return barcodes[0]?.rawValue ?? null;
  } catch {
    // No Play Services / cancelled Google UI → let the in-app scanner try.
    return undefined;
  }
}

/**
 * In-app scanner: request the camera permission, start the transparent-WebView
 * preview, and resolve on the first decoded QR (or `null` when the user backs
 * out). The screen is responsible for the "point your camera" chrome; here we
 * only drive the plugin and always `stopScan()` on the way out.
 */
async function startScanFallback(plugin: BarcodeScannerPlugin): Promise<string | null> {
  if (typeof plugin.startScan !== 'function' || typeof plugin.addListener !== 'function') {
    throw new ScanUnavailableError('This device cannot scan the code', 'unsupported');
  }

  const granted = await ensureCameraPermission(plugin);
  if (!granted) {
    throw new ScanUnavailableError('Camera permission is needed to scan the code', 'permission-denied');
  }

  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    let handle: { remove: () => Promise<void> } | undefined;

    const cleanup = async () => {
      try {
        await handle?.remove();
      } catch {
        /* listener already gone */
      }
      try {
        await plugin.stopScan?.();
      } catch {
        /* preview already stopped */
      }
    };

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      void cleanup().then(() => resolve(value));
    };

    Promise.resolve(
      plugin.addListener!('barcodeScanned', (result) => {
        finish(result.barcode?.rawValue ?? null);
      }),
    )
      .then((h) => {
        handle = h;
        return plugin.startScan!({ formats: [QR_FORMAT] });
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        void cleanup().then(() => reject(err instanceof Error ? err : new Error(String(err))));
      });
  });
}

/** Ensure the CAMERA permission, prompting once if it hasn't been decided. */
async function ensureCameraPermission(plugin: BarcodeScannerPlugin): Promise<boolean> {
  const current: CameraPermissionState = (await plugin.checkPermissions()).camera;
  if (current === 'granted' || current === 'limited') return true;
  if (current === 'denied') return false;
  const asked: CameraPermissionState = (await plugin.requestPermissions()).camera;
  return asked === 'granted' || asked === 'limited';
}
