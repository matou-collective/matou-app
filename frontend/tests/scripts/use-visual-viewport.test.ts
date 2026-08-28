import { describe, it, expect, afterEach } from 'vitest';
import { effectScope } from 'vue';
import { useVisualViewport } from '../../src/composables/useVisualViewport';

/**
 * Minimal VisualViewport fake — the tests/scripts vitest env is `node` (no
 * jsdom), so `window.visualViewport` does not exist. This models the pieces
 * useVisualViewport relies on: a mutable `height`, add/removeEventListener,
 * and a helper to dispatch a synthetic `resize` (as the soft keyboard would).
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

  /** Number of live resize listeners (for asserting cleanup). */
  get listenerCount() {
    return this.listeners.size;
  }

  /** Simulate the keyboard opening/closing: change height and fire `resize`. */
  resizeTo(height: number) {
    this.height = height;
    for (const cb of this.listeners) cb();
  }
}

let vv: FakeVisualViewport;

function installVisualViewport(initialHeight: number) {
  vv = new FakeVisualViewport(initialHeight);
  (globalThis as unknown as { window: unknown }).window = { visualViewport: vv };
}

/** A window with no visualViewport (older browser). */
function installWindowWithoutVisualViewport() {
  (globalThis as unknown as { window: unknown }).window = {};
}

function uninstallWindow() {
  delete (globalThis as unknown as { window?: unknown }).window;
}

describe('useVisualViewport', () => {
  afterEach(() => {
    uninstallWindow();
  });

  it('reports the initial visual viewport height', () => {
    installVisualViewport(844);
    const scope = effectScope();
    scope.run(() => {
      const height = useVisualViewport();
      expect(height.value).toBe(844);
    });
    scope.stop();
  });

  it('shrinks when the keyboard opens and restores when it closes', () => {
    installVisualViewport(844);
    const scope = effectScope();
    scope.run(() => {
      const height = useVisualViewport();
      expect(height.value).toBe(844);
      // Keyboard opens: visual viewport shrinks.
      vv.resizeTo(520);
      expect(height.value).toBe(520);
      // Keyboard closes: full height restored.
      vv.resizeTo(844);
      expect(height.value).toBe(844);
    });
    scope.stop();
  });

  it('removes its listener when the scope is disposed', () => {
    installVisualViewport(844);
    const scope = effectScope();
    scope.run(() => {
      useVisualViewport();
    });
    expect(vv.listenerCount).toBe(1);
    scope.stop();
    expect(vv.listenerCount).toBe(0);
  });

  it('does not update after the scope is disposed', () => {
    installVisualViewport(844);
    const scope = effectScope();
    let heightRef: ReturnType<typeof useVisualViewport> | undefined;
    scope.run(() => {
      heightRef = useVisualViewport();
    });
    scope.stop();
    vv.resizeTo(520);
    expect(heightRef!.value).toBe(844);
  });

  it('falls back to null when visualViewport is unavailable', () => {
    installWindowWithoutVisualViewport();
    const scope = effectScope();
    scope.run(() => {
      const height = useVisualViewport();
      expect(height.value).toBeNull();
    });
    scope.stop();
  });

  it('falls back to null when window is unavailable (SSR)', () => {
    uninstallWindow();
    const scope = effectScope();
    scope.run(() => {
      const height = useVisualViewport();
      expect(height.value).toBeNull();
    });
    scope.stop();
  });

  it('returns a readonly ref (mutation is rejected)', () => {
    installVisualViewport(844);
    const scope = effectScope();
    scope.run(() => {
      const height = useVisualViewport();
      // @ts-expect-error readonly refs reject assignment at the type level
      height.value = 100;
      expect(height.value).toBe(844);
    });
    scope.stop();
  });
});
