/**
 * Issue #825 — on macOS the custom title-bar maximize control must enter native
 * fullscreen (own Space, the green-button convention) instead of merely zooming
 * the frameless window to the desktop work area.
 *
 * The desktop window is frameless (`frame: false`), so there is no native macOS
 * green traffic-light button. The custom maximize control called
 * BrowserWindow.maximize()/unmaximize() on every platform. On darwin
 * .maximize() only zooms to the available work area — it never goes fullscreen —
 * which is exactly the reporter's "only maximizes to the size of the desktop
 * window… but not its own window".
 *
 * These tests exercise the platform branch in src-electron/window-controls.ts
 * with a fake window, asserting darwin toggles fullscreen while Windows/Linux
 * keep the byte-for-byte maximize/unmaximize behaviour.
 */
import { describe, it, expect } from 'vitest';
import {
  toggleWindowMaximize,
  isWindowMaximized,
  type WindowControls,
} from '../../src-electron/window-controls';

function fakeWindow(initial: { maximized?: boolean; fullScreen?: boolean } = {}) {
  const state = {
    maximized: initial.maximized ?? false,
    fullScreen: initial.fullScreen ?? false,
    calls: [] as string[],
  };
  const win: WindowControls = {
    isMaximized: () => state.maximized,
    maximize: () => {
      state.calls.push('maximize');
      state.maximized = true;
    },
    unmaximize: () => {
      state.calls.push('unmaximize');
      state.maximized = false;
    },
    isFullScreen: () => state.fullScreen,
    setFullScreen: (flag: boolean) => {
      state.calls.push(`setFullScreen:${flag}`);
      state.fullScreen = flag;
    },
  };
  return { win, state };
}

describe('issue #825 — macOS maximize enters native fullscreen', () => {
  it('darwin: toggle enters fullscreen and never calls maximize()', () => {
    const { win, state } = fakeWindow();
    toggleWindowMaximize(win, 'darwin');
    expect(state.fullScreen).toBe(true);
    expect(state.calls).toEqual(['setFullScreen:true']);
    // The old behaviour (zoom-to-work-area) must not fire on macOS.
    expect(state.calls).not.toContain('maximize');
  });

  it('darwin: a second toggle exits fullscreen back to the prior size', () => {
    const { win, state } = fakeWindow({ fullScreen: true });
    toggleWindowMaximize(win, 'darwin');
    expect(state.fullScreen).toBe(false);
    expect(state.calls).toEqual(['setFullScreen:false']);
  });

  it('darwin: maximized state reports fullscreen, not isMaximized', () => {
    const { win } = fakeWindow({ fullScreen: true, maximized: false });
    expect(isWindowMaximized(win, 'darwin')).toBe(true);
    const restored = fakeWindow({ fullScreen: false, maximized: true });
    expect(isWindowMaximized(restored.win, 'darwin')).toBe(false);
  });

  it.each(['win32', 'linux'] as NodeJS.Platform[])(
    '%s: maximize/unmaximize behaviour is unchanged (no fullscreen)',
    (platform) => {
      const { win, state } = fakeWindow();
      toggleWindowMaximize(win, platform);
      expect(state.maximized).toBe(true);
      expect(state.calls).toEqual(['maximize']);

      toggleWindowMaximize(win, platform);
      expect(state.maximized).toBe(false);
      expect(state.calls).toEqual(['maximize', 'unmaximize']);

      // Fullscreen is never touched off darwin.
      expect(state.calls.some((c) => c.startsWith('setFullScreen'))).toBe(false);
    },
  );

  it.each(['win32', 'linux'] as NodeJS.Platform[])(
    '%s: maximized state reports isMaximized, not fullscreen',
    (platform) => {
      const { win } = fakeWindow({ maximized: true, fullScreen: false });
      expect(isWindowMaximized(win, platform)).toBe(true);
      const notMax = fakeWindow({ maximized: false, fullScreen: true });
      expect(isWindowMaximized(notMax.win, platform)).toBe(false);
    },
  );
});
