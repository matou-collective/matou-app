import { describe, it, expect, afterEach } from 'vitest';
import { effectScope } from 'vue';
import { useIsMobile, MOBILE_BREAKPOINT } from '../../src/composables/useIsMobile';

/**
 * Minimal MediaQueryList fake — the tests/scripts vitest env is `node` (no
 * jsdom), so `window.matchMedia` does not exist. This models the pieces
 * useIsMobile relies on: a mutable `matches` flag, add/removeEventListener,
 * and a helper to dispatch a synthetic `change`.
 */
class FakeMediaQueryList {
  matches: boolean;
  readonly media: string;
  private listeners = new Set<(e: { matches: boolean }) => void>();

  constructor(media: string, matches: boolean) {
    this.media = media;
    this.matches = matches;
  }

  addEventListener(type: string, cb: (e: { matches: boolean }) => void) {
    if (type === 'change') this.listeners.add(cb);
  }

  removeEventListener(type: string, cb: (e: { matches: boolean }) => void) {
    if (type === 'change') this.listeners.delete(cb);
  }

  /** Number of live change listeners (for asserting cleanup). */
  get listenerCount() {
    return this.listeners.size;
  }

  /** Simulate a viewport change. */
  set(matches: boolean) {
    this.matches = matches;
    for (const cb of this.listeners) cb({ matches });
  }
}

let mql: FakeMediaQueryList;

function installMatchMedia(initialMatches: boolean) {
  mql = new FakeMediaQueryList(`(max-width: ${MOBILE_BREAKPOINT}px)`, initialMatches);
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: (query: string) => {
      expect(query).toBe(`(max-width: ${MOBILE_BREAKPOINT}px)`);
      return mql;
    },
  };
}

function uninstallWindow() {
  delete (globalThis as unknown as { window?: unknown }).window;
}

describe('useIsMobile', () => {
  afterEach(() => {
    uninstallWindow();
  });

  it('exposes the 767px breakpoint constant', () => {
    expect(MOBILE_BREAKPOINT).toBe(767);
  });

  it('is true when the viewport matches (≤767px)', () => {
    installMatchMedia(true);
    const scope = effectScope();
    scope.run(() => {
      const isMobile = useIsMobile();
      expect(isMobile.value).toBe(true);
    });
    scope.stop();
  });

  it('is false when the viewport does not match (≥768px)', () => {
    installMatchMedia(false);
    const scope = effectScope();
    scope.run(() => {
      const isMobile = useIsMobile();
      expect(isMobile.value).toBe(false);
    });
    scope.stop();
  });

  it('reacts to viewport changes', () => {
    installMatchMedia(false);
    const scope = effectScope();
    scope.run(() => {
      const isMobile = useIsMobile();
      expect(isMobile.value).toBe(false);
      mql.set(true);
      expect(isMobile.value).toBe(true);
      mql.set(false);
      expect(isMobile.value).toBe(false);
    });
    scope.stop();
  });

  it('removes its listener when the scope is disposed', () => {
    installMatchMedia(true);
    const scope = effectScope();
    scope.run(() => {
      useIsMobile();
    });
    expect(mql.listenerCount).toBe(1);
    scope.stop();
    expect(mql.listenerCount).toBe(0);
  });

  it('does not update after the scope is disposed', () => {
    installMatchMedia(false);
    const scope = effectScope();
    let isMobileRef: ReturnType<typeof useIsMobile> | undefined;
    scope.run(() => {
      isMobileRef = useIsMobile();
    });
    scope.stop();
    // A change after disposal must not mutate the (now detached) ref.
    mql.set(true);
    expect(isMobileRef!.value).toBe(false);
  });

  it('falls back to false when matchMedia is unavailable (SSR)', () => {
    uninstallWindow();
    const scope = effectScope();
    scope.run(() => {
      const isMobile = useIsMobile();
      expect(isMobile.value).toBe(false);
    });
    scope.stop();
  });

  it('returns a readonly ref (mutation is rejected)', () => {
    installMatchMedia(true);
    const scope = effectScope();
    scope.run(() => {
      const isMobile = useIsMobile();
      // @ts-expect-error readonly refs reject assignment at the type level
      isMobile.value = false;
      // Value is unchanged despite the attempted write.
      expect(isMobile.value).toBe(true);
    });
    scope.stop();
  });
});
