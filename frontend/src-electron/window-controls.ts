/**
 * Platform-aware window maximize/restore behaviour for the frameless desktop
 * window. Extracted from the IPC handlers so the platform branch can be unit
 * tested without an Electron BrowserWindow. See issue #825.
 *
 * On macOS the frameless window has no native green traffic-light button, and
 * BrowserWindow.maximize() only *zooms* the window to the desktop work area —
 * it never enters native fullscreen. The custom title-bar maximize control
 * must therefore toggle native fullscreen (own Space, the Mac convention) on
 * darwin, while keeping the conventional maximize/unmaximize toggle on Windows
 * and Linux.
 */

/** The subset of Electron's BrowserWindow this logic touches. */
export interface WindowControls {
  isMaximized(): boolean;
  maximize(): void;
  unmaximize(): void;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
}

/**
 * Toggle the window's "maximized" state as the platform expects:
 * native fullscreen on macOS, maximize/unmaximize elsewhere.
 */
export function toggleWindowMaximize(
  win: WindowControls,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'darwin') {
    win.setFullScreen(!win.isFullScreen());
  } else if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
}

/**
 * Report whether the window is in its "maximized" state for the title bar's
 * restore/maximize icon: fullscreen on macOS, maximized elsewhere.
 */
export function isWindowMaximized(
  win: WindowControls,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' ? win.isFullScreen() : win.isMaximized();
}
