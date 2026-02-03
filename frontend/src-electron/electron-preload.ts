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
  secureStorageGet: (key: string) => ipcRenderer.invoke('secure-storage-get', key),
  secureStorageSet: (key: string, value: string) => ipcRenderer.invoke('secure-storage-set', key, value),
  secureStorageRemove: (key: string) => ipcRenderer.invoke('secure-storage-remove', key),
});
