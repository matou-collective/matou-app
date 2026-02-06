/**
 * Electron Main Process
 * Spawns the Go backend as a child process, waits for it to become healthy,
 * then creates the BrowserWindow pointing at the Quasar frontend.
 */
import { app, BrowserWindow, ipcMain, safeStorage, nativeImage } from 'electron';
import { ChildProcess, spawn, execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import fs from 'fs';

// ESM compatibility: __dirname is not available in ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Force WM_CLASS to 'matou' so Linux DEs can match it to the .desktop file
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', 'matou');
  app.setDesktopName('matou.desktop');
}

/**
 * Install .desktop file and icons for Linux desktop integration.
 * AppImages don't install these automatically, so the DE can't find the
 * application icon without them. Runs once on first launch.
 */
function installDesktopIntegration(): void {
  if (process.platform !== 'linux' || !app.isPackaged) return;

  const appsDir = path.join(app.getPath('home'), '.local', 'share', 'applications');
  const desktopFile = path.join(appsDir, 'matou.desktop');

  // Find the AppImage path from the environment (set by AppImage runtime)
  const appImagePath = process.env.APPIMAGE;
  if (!appImagePath) return;

  // Skip if already installed and pointing to the same AppImage
  if (fs.existsSync(desktopFile)) {
    const existing = fs.readFileSync(desktopFile, 'utf-8');
    if (existing.includes(appImagePath)) return;
  }

  // Install icons to ~/.local/share/icons/hicolor/
  const iconsBase = path.join(app.getPath('home'), '.local', 'share', 'icons', 'hicolor');
  const sizes = [16, 32, 48, 64, 128, 256, 512];
  for (const size of sizes) {
    const srcIcon = path.join(process.resourcesPath, 'icons', `${size}x${size}.png`);
    if (!fs.existsSync(srcIcon)) continue;
    const destDir = path.join(iconsBase, `${size}x${size}`, 'apps');
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcIcon, path.join(destDir, 'matou.png'));
  }

  // Write .desktop file
  fs.mkdirSync(appsDir, { recursive: true });
  const desktopContent = `[Desktop Entry]
Name=Matou
Exec="${appImagePath}" %U
Terminal=false
Type=Application
Icon=matou
StartupWMClass=matou
Categories=Network;
Comment=Matou Community
`;
  fs.writeFileSync(desktopFile, desktopContent, { mode: 0o755 });
  console.log('[Electron] Installed desktop integration:', desktopFile);
}

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendPort = 0;

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
    const platformMap: Record<string, string> = {
      darwin: 'darwin-arm64',
      linux: 'linux-amd64',
      win32: 'windows-amd64',
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
  const backendPath = getBackendPath();
  const dataDir = path.join(app.getPath('userData'), 'matou-data');

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
      ...(isProduction && {
        MATOU_ENV: 'production',
        MATOU_CONFIG_SERVER_URL: process.env.PROD_CONFIG_SERVER_URL,
        MATOU_SMTP_HOST: process.env.PROD_SMTP_HOST,
        MATOU_SMTP_PORT: process.env.PROD_SMTP_PORT,
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[Backend] ${data.toString().trimEnd()}`);
  });

  backendProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[Backend:err] ${data.toString().trimEnd()}`);
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Mātou',
    backgroundColor: '#1e5f74',
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
    // Fallback: store plaintext (some Linux systems lack keyring)
    store[key] = value;
  }

  writeSecureStore(store);
});

ipcMain.handle('secure-storage-remove', (_event, key: string): void => {
  const store = readSecureStore();
  delete store[key];
  writeSecureStore(store);
});

app.whenReady().then(async () => {
  installDesktopIntegration();
  try {
    await startBackend();
    createWindow();
  } catch (err) {
    console.error('[Electron] Failed to start backend:', err);
    app.quit();
  }
});

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
