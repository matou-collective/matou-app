import { ref, readonly, onScopeDispose, type Ref } from 'vue';

/**
 * Mobile viewport breakpoint (px). Matches the `max-width: 767px` breakpoint
 * used across the app (DashboardLayout.vue, DashboardPage.vue) and the global
 * dialog override in `src/css/app.scss`.
 */
export const MOBILE_BREAKPOINT = 767;

const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

/**
 * Reactive flag that tracks whether the viewport is at or below the mobile
 * breakpoint (≤767px). Backed by `matchMedia` so it updates on resize /
 * orientation change without a manual resize listener.
 *
 * The `change` listener is removed automatically when the owning effect scope
 * (component `setup`, or an explicit `effectScope`) is disposed.
 *
 * SSR / non-DOM environments (where `window.matchMedia` is unavailable) fall
 * back to a static `false` so the composable is safe to call anywhere.
 */
export function useIsMobile(): Readonly<Ref<boolean>> {
  const isMobile = ref(false);

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return readonly(isMobile);
  }

  const mql = window.matchMedia(MOBILE_QUERY);
  isMobile.value = mql.matches;

  const update = (e: MediaQueryListEvent | MediaQueryList) => {
    isMobile.value = e.matches;
  };

  // Older Safari/WebView expose addListener/removeListener instead of
  // addEventListener('change', …); support both for the Android WebView target.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', update);
    onScopeDispose(() => mql.removeEventListener('change', update));
  } else if (typeof mql.addListener === 'function') {
    mql.addListener(update);
    onScopeDispose(() => mql.removeListener(update));
  }

  return readonly(isMobile);
}
