import { describe, it, expect, afterEach } from 'vitest';
import { effectScope } from 'vue';
import { useKeyboardOpen, KEYBOARD_MIN_HEIGHT } from '../../src/composables/useKeyboardOpen';

/**
 * The tests/scripts vitest env is `node` (no jsdom), so we stand up a minimal
 * `window` fake exposing exactly what useKeyboardOpen relies on:
 *  - add/removeEventListener for the Capacitor `keyboardWillShow/Hide` events,
 *  - a mutable `innerHeight`, and
 *  - a `visualViewport` with a mutable `height` + its own resize listeners.
 */
class FakeVisualViewport {
  height: number;
  private listeners = new Set<() => void>();

  constructor(height: number) {
    this.height = height;
  }

  addEventListener(type: string, cb: () => void) {
    if (type === 'resize') this.listeners.add(cb);
  }

  removeEventListener(type: string, cb: () => void) {
    if (type === 'resize') this.listeners.delete(cb);
  }

  get listenerCount() {
    return this.listeners.size;
  }

  /** Simulate the visual viewport resizing (keyboard open/close). */
  set(height: number) {
    this.height = height;
    for (const cb of this.listeners) cb();
  }
}

class FakeWindow {
  innerHeight: number;
  visualViewport: FakeVisualViewport;
  private listeners = new Map<string, Set<() => void>>();

  constructor(innerHeight: number) {
    this.innerHeight = innerHeight;
    this.visualViewport = new FakeVisualViewport(innerHeight);
  }

  addEventListener(type: string, cb: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** Fire a Capacitor keyboard window event. */
  emit(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
}

let win: FakeWindow;

function installWindow(innerHeight = 800) {
  win = new FakeWindow(innerHeight);
  (globalThis as unknown as { window: unknown }).window = win;
}

function uninstallWindow() {
  delete (globalThis as unknown as { window?: unknown }).window;
}

describe('useKeyboardOpen', () => {
  afterEach(() => {
    uninstallWindow();
  });

  it('exposes the minimum-height threshold constant', () => {
    expect(KEYBOARD_MIN_HEIGHT).toBe(150);
  });

  it('is false at rest (visual viewport equals layout viewport)', () => {
    installWindow(800);
    const scope = effectScope();
    scope.run(() => {
      expect(useKeyboardOpen().value).toBe(false);
    });
    scope.stop();
  });

  it('flips true when the visual viewport shrinks past the threshold', () => {
    installWindow(800);
    const scope = effectScope();
    scope.run(() => {
      const open = useKeyboardOpen();
      expect(open.value).toBe(false);
      win.visualViewport.set(500); // keyboard eats 300px
      expect(open.value).toBe(true);
      win.visualViewport.set(800); // keyboard closes
      expect(open.value).toBe(false);
    });
    scope.stop();
  });

  it('ignores viewport losses below the threshold (browser chrome jitter)', () => {
    installWindow(800);
    const scope = effectScope();
    scope.run(() => {
      const open = useKeyboardOpen();
      win.visualViewport.set(800 - (KEYBOARD_MIN_HEIGHT - 10)); // 140px loss
      expect(open.value).toBe(false);
    });
    scope.stop();
  });

  it('Capacitor keyboard events are authoritative over the viewport heuristic', () => {
    installWindow(800);
    const scope = effectScope();
    scope.run(() => {
      const open = useKeyboardOpen();
      win.emit('keyboardWillShow');
      expect(open.value).toBe(true);
      // Even if the viewport never reports a shrink, the explicit hide wins.
      win.emit('keyboardWillHide');
      expect(open.value).toBe(false);
    });
    scope.stop();
  });

  it('removes both keyboard and viewport listeners when the scope is disposed', () => {
    installWindow(800);
    const scope = effectScope();
    scope.run(() => {
      useKeyboardOpen();
    });
    expect(win.listenerCount('keyboardWillShow')).toBe(1);
    expect(win.listenerCount('keyboardWillHide')).toBe(1);
    expect(win.visualViewport.listenerCount).toBe(1);
    scope.stop();
    expect(win.listenerCount('keyboardWillShow')).toBe(0);
    expect(win.listenerCount('keyboardWillHide')).toBe(0);
    expect(win.visualViewport.listenerCount).toBe(0);
  });

  it('does not update after the scope is disposed', () => {
    installWindow(800);
    const scope = effectScope();
    let openRef: ReturnType<typeof useKeyboardOpen> | undefined;
    scope.run(() => {
      openRef = useKeyboardOpen();
    });
    scope.stop();
    win.visualViewport.set(400);
    expect(openRef!.value).toBe(false);
  });

  it('falls back to false when window is unavailable (SSR)', () => {
    uninstallWindow();
    const scope = effectScope();
    scope.run(() => {
      expect(useKeyboardOpen().value).toBe(false);
    });
    scope.stop();
  });
});
