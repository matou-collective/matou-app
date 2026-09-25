/**
 * Electron Main Process
 * Spawns the Go backend as a child process, waits for it to become healthy,
 * then creates the BrowserWindow pointing at the Quasar frontend.
 */
import { app, BrowserWindow, ipcMain, safeStorage, nativeImage, Notification, shell } from 'electron';
import electronUpdater from 'electron-updater';

import log from 'electron-log';
import { ChildProcess, spawn, execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import fs from 'fs';
import crypto from 'crypto';
// Brand identity, colours and the auto-update gate come from the generated kit
// (produced by `npm run kit:apply` from coa-kit/kit.json). See Matou/coa ADR 0004.
import { KIT, KIT_BUILD } from 'src/generated/kit';
import { kitUserDataPath } from './kit-paths';
import { buildDesktopEntry, schemeHandlerMimeType } from './desktop-entry';
import { resolveIdentityKey } from './identity-key';

// Using destructuring to access autoUpdater due to the CommonJS module of 'electron-updater'.
// It is a workaround for ESM compatibility issues, see https://github.com/electron-userland/electron-builder/issues/7976.
const { autoUpdater } = electronUpdater;

// ESM compatibility: __dirname is not available in ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Isolate each branded kit's state under its own userData root. At runtime
// app.getName() falls back to the asar package.json ("Matou"), so without this a
// kit-branded fork inherits the stock Matou userData dir and its identity +
// backend data (issue #344). Must run before any app.getPath('userData') read
// (secureStorePath below, startBackend's dataDir) and before app is ready.
// Stock Matou's productName is "Matou" → path unchanged, no data orphaned.
app.setPath('userData', kitUserDataPath(app.getPath('appData'), KIT_BUILD));

// Prevent EPIPE crashes when stdout/stderr pipes are broken
// (common in packaged AppImage — no terminal attached to receive output)
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

// Force the X11 WM_CLASS to the kit executable name so X11 DEs can match the
// window to the .desktop file (StartupWMClass, written in
// installDesktopIntegration). On native Wayland this switch does NOT set the
// xdg app_id — GNOME matches a Wayland window to its .desktop by app_id, which
// Chromium derives from the packaged package.json `name`. That name is pinned
// to executableName via electron-builder `extraMetadata` (kit-builder-config.ts)
// so both the X11 WM_CLASS and the Wayland app_id equal executableName (#617).
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', KIT_BUILD.executableName);
  app.setDesktopName(`${KIT_BUILD.executableName}.desktop`);
}

// Windows requires AUMID to be set before any Notification is shown, otherwise
// toasts appear under "electron.app" in the Action Center.
if (process.platform === 'win32') {
  app.setAppUserModelId(KIT_BUILD.appId);
}

// --- Sign-in link scheme (#532, idss #1492 story 34) ---
// Claim `matou://` so a community sign-in link (and the pairing link) opens the
// desktop app; the renderer's deep-link handler routes it to the approve card
// or the link-device screen. The scheme is the same across every branded kit
// (the links are minted as `matou://…`), so it is not derived from KIT_BUILD.
const DEEP_LINK_SCHEME = 'matou';

// Register as the OS protocol client. In a packaged app the executable is the
// handler; in dev (`process.defaultApp`) Electron runs a script, so the exec +
// script path must be spelled out or the OS would relaunch electron with no app.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
}

// A deep link that arrived before the window/renderer was ready to receive it
// (cold start on any OS, or an open-url that beat createWindow). Flushed on the
// window's did-finish-load.
let pendingDeepLink: string | null = null;

/** The first `matou://…` argument in an argv, or null. */
function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}

/**
 * Hand a deep-link URL to the renderer, or stash it until the window is loaded.
 * Focuses the window so an already-running app comes forward on the link.
 */
function deliverDeepLink(url: string): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('deep-link', url);
  } else {
    pendingDeepLink = url;
  }
}

// macOS delivers the link through open-url (both cold start and already-running).
// Registered before whenReady so a cold-start link is not missed.
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

// A single instance owns the scheme: on Windows/Linux the OS launches a second
// process for the link, whose argv carries the URL — forward it to the running
// instance and quit the duplicate. Without the lock "already running" would spawn
// a second app (and a second backend) instead of coming forward.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = deepLinkFromArgv(argv);
    if (url) deliverDeepLink(url);
    else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Auto-Updater setup. Only kits with a publish target (KIT_BUILD.updates) ship
// an app-update.yml, so gate the updater on it — a community kit has none.
const enableAutoUpdate = app.isPackaged && KIT_BUILD.updates;

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = true;

/**
 * Install .desktop file and icons for Linux desktop integration.
 * AppImages don't install these automatically, so the DE can't find the
 * application icon without them. Runs once on first launch.
 */
function installDesktopIntegration(): void {
  if (process.platform !== 'linux' || !app.isPackaged) return;

  const appsDir = path.join(app.getPath('home'), '.local', 'share', 'applications');
  const desktopFile = path.join(appsDir, `${KIT_BUILD.executableName}.desktop`);
  const schemeMimeType = schemeHandlerMimeType(DEEP_LINK_SCHEME);

  // Find the AppImage path from the environment (set by AppImage runtime)
  const appImagePath = process.env.APPIMAGE;
  if (!appImagePath) return;

  // Skip if already installed, pointing to the same AppImage, AND already
  // carrying the scheme-handler MimeType line. The MimeType check lets an
  // install made before the #623 fix repair itself on next launch — the path
  // is unchanged, so without it the early return would keep the broken entry.
  if (fs.existsSync(desktopFile)) {
    const existing = fs.readFileSync(desktopFile, 'utf-8');
    if (existing.includes(appImagePath) && existing.includes(schemeMimeType)) return;
  }

  // Install icons to ~/.local/share/icons/hicolor/
  const iconsBase = path.join(app.getPath('home'), '.local', 'share', 'icons', 'hicolor');
  const sizes = [16, 32, 48, 64, 128, 256, 512];
  for (const size of sizes) {
    const srcIcon = path.join(process.resourcesPath, 'icons', `${size}x${size}.png`);
    if (!fs.existsSync(srcIcon)) continue;
    const destDir = path.join(iconsBase, `${size}x${size}`, 'apps');
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcIcon, path.join(destDir, `${KIT_BUILD.executableName}.png`));
  }

  // Write .desktop file. The MimeType=x-scheme-handler/<scheme>; line is what
  // makes the sign-in link's "open the app on this computer" (a matou:// link)
  // resolve to us — app.setAsDefaultProtocolClient only takes effect on Linux
  // once a registered .desktop declares the scheme (#623).
  fs.mkdirSync(appsDir, { recursive: true });
  const desktopContent = buildDesktopEntry({
    name: KIT.brand.name,
    executableName: KIT_BUILD.executableName,
    appImagePath,
    scheme: DEEP_LINK_SCHEME,
  });
  fs.writeFileSync(desktopFile, desktopContent, { mode: 0o755 });
  console.log('[Electron] Installed desktop integration:', desktopFile);

  // Refresh the DE's MIME cache and set us as the default handler for the
  // scheme. Both are best-effort: xdg-utils / desktop-file-utils may be absent
  // on a minimal system, in which case the MimeType line above still lets the
  // browser's "Open with" dialog find us. Logged, never fatal.
  const desktopId = `${KIT_BUILD.executableName}.desktop`;
  try {
    execFileSync('update-desktop-database', [appsDir], { stdio: 'ignore' });
  } catch (err) {
    log.warn(`[Electron] update-desktop-database unavailable (install desktop-file-utils to auto-register the ${DEEP_LINK_SCHEME}:// handler):`, err);
  }
  try {
    execFileSync('xdg-mime', ['default', desktopId, schemeMimeType], { stdio: 'ignore' });
  } catch (err) {
    log.warn(`[Electron] xdg-mime unavailable (install xdg-utils to auto-register the ${DEEP_LINK_SCHEME}:// handler):`, err);
  }
}

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendPort = 0;
// Random per-launch token shared with the backend (via MATOU_API_TOKEN) and the
// renderer (via IPC). The backend's TokenGuard requires it on mutating requests,
// blocking other local processes from issuing them.
let apiToken = '';

// Sealed per-install identity encryption key (issue #117). Lives directly under
// userData — outside the backend's matou-data dir — so resetting backend data
// never churns the key that decrypts an existing identity.json.
const identityKeyPath = path.join(app.getPath('userData'), 'identity-key.enc');

/**
 * Find a free TCP port.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not get port')));
      }
    });
    server.on('error', reject);
  });
}

/**
 * Resolve the path to the Go backend binary.
 * In development it's in the backend/bin directory; when packaged it's in extraResources.
 */
function getBackendPath(): string {
  if (app.isPackaged) {
    // Packaged app: binary is in resources/backend/
    const archMap: Record<string, string> = { arm64: 'arm64', x64: 'amd64' };
    const arch = archMap[process.arch] ?? 'amd64';
    const platformMap: Record<string, string> = {
      darwin: `darwin-${arch}`,
      linux: `linux-${arch}`,
      win32: `windows-${arch}`,
    };
    const platformDir = platformMap[process.platform] ?? 'linux-amd64';
    const binaryName = process.platform === 'win32' ? 'matou-backend.exe' : 'matou-backend';
    return path.join(process.resourcesPath, 'backend', platformDir, binaryName);
  }

  // Development: run from the backend directory
  // __dirname is .quasar/dev-electron/ in dev, so go up 3 levels to reach the monorepo root
  return path.join(__dirname, '..', '..', '..', 'backend', 'bin', 'server');
}

/**
 * Spawn the Go backend and wait until /health returns 200.
 */
async function startBackend(): Promise<void> {
  backendPort = await findFreePort();
  apiToken = crypto.randomBytes(32).toString('hex');
  const backendPath = getBackendPath();
  const dataDir = path.join(app.getPath('userData'), 'matou-data');

  // Per-install key that encrypts the backend's identity.json at rest (issue
  // #117). Sealed with the OS keyring (safeStorage) and stored outside the
  // backend data dir so a data-dir reset doesn't churn it. Empty when the
  // keyring is unavailable → backend keeps the legacy plaintext format.
  const identityKey = resolveIdentityKey(safeStorage, fs, identityKeyPath, log);

  // Detect production mode: packaged app or explicit env var
  const isProduction = app.isPackaged || process.env.MATOU_ENV === 'production';

  console.log(`[Electron] Starting backend: ${backendPath}`);
  console.log(`[Electron] Port: ${backendPort}, Data dir: ${dataDir}`);
  console.log(`[Electron] Production mode: ${isProduction}`);

  backendProcess = spawn(backendPath, [], {
    env: {
      ...process.env,
      MATOU_SERVER_PORT: String(backendPort),
      MATOU_DATA_DIR: dataDir,
      MATOU_CORS_MODE: 'bundled',
      MATOU_API_TOKEN: apiToken,
      // Only set when the keyring sealed a key; empty keeps the legacy plaintext path.
      ...(identityKey !== '' && { MATOU_IDENTITY_KEY: identityKey }),
      ...(isProduction && {
        MATOU_ENV: 'production',
        MATOU_CONFIG_SERVER_URL: process.env.PROD_CONFIG_SERVER_URL,
        MATOU_SMTP_HOST: process.env.PROD_SMTP_HOST,
        MATOU_SMTP_PORT: process.env.PROD_SMTP_PORT,
        MATOU_SMTP_RELAY_URL: process.env.PROD_CONFIG_SERVER_URL,
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendProcess.stdout?.on('data', (data: Buffer) => {
    log.info(`[Backend] ${data.toString().trimEnd()}`);
  });

  backendProcess.stderr?.on('data', (data: Buffer) => {
    log.warn(`[Backend:err] ${data.toString().trimEnd()}`);
  });

  backendProcess.on('exit', (code) => {
    console.log(`[Electron] Backend exited with code ${code}`);
    backendProcess = null;
  });

  // Poll /health until ready (max 30 seconds)
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${backendPort}/health`);
      if (res.ok) {
        console.log(`[Electron] Backend healthy after ${i + 1} attempts`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error('Backend did not become healthy within 30 seconds');
}

/**
 * Stop the backend process gracefully.
 */
function stopBackend(): Promise<void> {
  return new Promise((resolve) => {
    if (!backendProcess) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      console.log('[Electron] Backend did not exit gracefully, killing');
      backendProcess?.kill('SIGKILL');
      resolve();
    }, 5000);

    backendProcess.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    backendProcess.kill('SIGTERM');
  });
}

/**
 * Decide whether a navigation target should be handed to the OS browser
 * instead of loaded inside the app window. External web/mail links (in
 * contribution reports, comments, chat, etc.) must open externally; the app's
 * own origin must keep navigating in-window.
 */
function isExternalUrl(target: string, currentUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  if (parsed.protocol === 'mailto:') return true;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // Same-origin http(s) navigation (e.g. the dev server) stays in-window.
  try {
    return parsed.origin !== new URL(currentUrl).origin;
  } catch {
    return true;
  }
}

/**
 * Route clicked links to the OS default browser. Links rendered in message,
 * report and comment bodies get `target="_blank"`, which fires
 * `setWindowOpenHandler`; plain in-body navigations are caught by
 * `will-navigate`. Both are denied in-window and opened externally instead.
 */
function setupExternalLinkHandling(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isExternalUrl(url, window.webContents.getURL())) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: KIT.brand.name,
    backgroundColor: KIT_BUILD.backgroundColour,
    icon: nativeImage.createFromPath(
      app.isPackaged
        ? path.join(process.resourcesPath, 'icons', '256x256.png')
        : path.join(__dirname, '..', '..', '..', 'src-electron', 'icons', '256x256.png'),
    ),
    frame: false,
    webPreferences: {
      preload: path.resolve(__dirname, process.env.QUASAR_ELECTRON_PRELOAD!),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupExternalLinkHandling(mainWindow);

  // Forward renderer console output into main.log. Packaged builds have no
  // devtools, so without this every renderer-side warning (e.g. a failed
  // approval step) is invisible in the field.
  mainWindow.webContents.on('console-message', (details) => {
    const { level, message, lineNumber, sourceId } = details;
    const src = sourceId ? `${sourceId.split('/').pop() ?? sourceId}:${lineNumber}` : '';
    const text = `[renderer] ${src} ${message}`;
    if (level === 'error') log.error(text);
    else if (level === 'warning') log.warn(text);
    else log.info(text);
  });

  // Flush a deep link that arrived before the renderer was ready (#532):
  // cold-start argv/open-url, or an open-url that beat createWindow.
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) {
      mainWindow?.webContents.send('deep-link', pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  if (process.env.DEV) {
    mainWindow.loadURL(process.env.APP_URL!);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile('index.html');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC handlers for preload API
ipcMain.handle('get-backend-port', () => backendPort);
ipcMain.handle('get-data-dir', () => path.join(app.getPath('userData'), 'matou-data'));
ipcMain.handle('get-api-token', () => apiToken);

// Window control IPC handlers
ipcMain.handle('window-minimize', () => mainWindow?.minimize());
ipcMain.handle('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.handle('window-close', () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

// --- Secure storage IPC handlers (OS-level encryption via safeStorage) ---
const secureStorePath = path.join(app.getPath('userData'), 'matou-data', 'secure-store.json');

function readSecureStore(): Record<string, string> {
  try {
    if (fs.existsSync(secureStorePath)) {
      return JSON.parse(fs.readFileSync(secureStorePath, 'utf-8'));
    }
  } catch (err) {
    console.warn('[SecureStorage] Failed to read store:', err);
  }
  return {};
}

function writeSecureStore(store: Record<string, string>): void {
  const dir = path.dirname(secureStorePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(secureStorePath, JSON.stringify(store, null, 2), 'utf-8');
}

ipcMain.handle('secure-storage-get', (_event, key: string): string | null => {
  const store = readSecureStore();
  const value = store[key];
  if (value === undefined) return null;

  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch (err) {
      console.warn('[SecureStorage] Decrypt failed for key:', key, err);
      return null;
    }
  }
  // Fallback: value stored as plaintext
  return value;
});

ipcMain.handle('secure-storage-set', (_event, key: string, value: string): void => {
  const store = readSecureStore();

  if (safeStorage.isEncryptionAvailable()) {
    store[key] = safeStorage.encryptString(value).toString('base64');
  } else {
    // SECURITY WARNING: storing plaintext because OS keyring is unavailable.
    // This happens on some Linux systems without gnome-keyring or kwallet.
    // The passcode and mnemonic will be readable on disk.
    log.warn(`[SecureStorage] Encryption unavailable — storing "${key}" as plaintext. Install a keyring (gnome-keyring, kwallet) for OS-level encryption.`);
    store[key] = value;
  }

  writeSecureStore(store);
});

ipcMain.handle('secure-storage-remove', (_event, key: string): void => {
  const store = readSecureStore();
  delete store[key];
  writeSecureStore(store);
});

ipcMain.handle('install-update', () => {
  log.info('[Updater] User requested install, quitting and installing...');
  autoUpdater.quitAndInstall();
});

// --- Notification IPC ---
interface NotifyPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

ipcMain.on('notify', (_event, payload: NotifyPayload) => {
  if (!Notification.isSupported()) return;

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons', '256x256.png')
    : path.join(__dirname, '..', '..', '..', 'src-electron', 'icons', '256x256.png');

  const notification = new Notification({
    title: payload.title,
    body: payload.body,
    icon: iconPath,
  });

  notification.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('notification-clicked', payload.data ?? {});
    }
  });

  notification.show();
});

function setupAutoUpdater(): void {
  if (!enableAutoUpdate) {
    log.info('[Updater] Disabled (dev mode)');
    return;
  }

  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('[Updater] Update available:', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    log.info('[Updater] No update available');
  });

  autoUpdater.on('error', (err) => {
    log.error('[Updater] Error:', err);
  });

  autoUpdater.on('update-downloaded', () => {
    log.info('[Updater] Update downloaded, notifying renderer');
    mainWindow?.webContents.send('update-downloaded');
  });

  autoUpdater.checkForUpdates();
}

// Only the primary instance starts the backend and window; a duplicate launched
// for a deep link has already forwarded its URL and quit (single-instance lock).
if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    installDesktopIntegration();
    setupAutoUpdater();
    // Windows/Linux carry a cold-start deep link in the launch argv.
    const initialDeepLink = deepLinkFromArgv(process.argv);
    if (initialDeepLink) pendingDeepLink = initialDeepLink;
    try {
      await startBackend();
      createWindow();
    } catch (err) {
      console.error('[Electron] Failed to start backend:', err);
      app.quit();
    }
  });
}

app.on('window-all-closed', async () => {
  await stopBackend();
  app.quit();
});

app.on('before-quit', async () => {
  await stopBackend();
});

// Export port for preload script
export function getBackendPort(): number {
  return backendPort;
}
