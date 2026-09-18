/**
 * Electron Preload Script
 * Exposes a safe API to the renderer process via contextBridge.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),
  getApiToken: () => ipcRenderer.invoke('get-api-token'),
  secureStorageGet: (key: string) => ipcRenderer.invoke('secure-storage-get', key),
  secureStorageSet: (key: string, value: string) => ipcRenderer.invoke('secure-storage-set', key, value),
  secureStorageRemove: (key: string) => ipcRenderer.invoke('secure-storage-remove', key),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onUpdateDownloaded: (callback: () => void) => {
    ipcRenderer.once('update-downloaded', () => callback());
  },
  installUpdate: () => ipcRenderer.invoke('install-update'),
  notify: (payload: { title: string; body: string; data?: Record<string, string> }) =>
    ipcRenderer.send('notify', payload),
  onNotificationClicked: (callback: (data: Record<string, string>) => void) => {
    ipcRenderer.on('notification-clicked', (_event, data: Record<string, string>) => callback(data));
  },
  // Sign-in link scheme (#532): the main process forwards a matou:// URL the OS
  // opened the app with (cold start), or handed the already-running instance
  // (macOS open-url / Windows+Linux second-instance).
  onDeepLink: (callback: (url: string) => void) => {
    ipcRenderer.on('deep-link', (_event, url: string) => callback(url));
  },
});
