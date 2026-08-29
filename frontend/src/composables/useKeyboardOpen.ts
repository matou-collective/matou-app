import { ref, computed, readonly, onScopeDispose, type Ref } from 'vue';

/**
 * Minimum viewport-height loss (px) that counts as "the soft keyboard is open".
 *
 * On the Android WebView the soft keyboard shrinks `visualViewport.height`
 * while the layout viewport (`window.innerHeight`) stays put; a real keyboard
 * eats ~250–350px, so a 150px floor comfortably clears browser-chrome jitter
 * and the URL bar without false-positiving.
 */
export const KEYBOARD_MIN_HEIGHT = 150;

/**
 * Reactive flag that tracks whether the on-screen (soft) keyboard is open.
 *
 * Two independent signals feed it, so the flag works whether or not the native
 * Capacitor Keyboard plugin is present (the app deliberately never bundles
 * `@capacitor/keyboard` — see `src/lib/capacitor.ts`):
 *
 *  1. **Capacitor window events** — when the native Keyboard plugin is
 *     installed it dispatches `keyboardWillShow` / `keyboardWillHide` as plain
 *     `window` events, which we listen to without importing the plugin. Once
 *     they fire they are authoritative.
 *  2. **`visualViewport` height** — the self-contained fallback. When the
 *     keyboard opens the visual viewport shrinks below the layout viewport by
 *     more than {@link KEYBOARD_MIN_HEIGHT}px. This alone fixes the reported
 *     bug on-device even with no keyboard plugin.
 *
 * Both listeners are removed automatically when the owning effect scope
 * (component `setup`, or an explicit `effectScope`) is disposed.
 *
 * Desktop / Electron / SSR are unaffected: with no soft keyboard the visual
 * viewport never shrinks (diff ≈ 0 < threshold) and the Capacitor events never
 * fire, so the flag stays `false`.
 */
export function useKeyboardOpen(): Readonly<Ref<boolean>> {
  // From the Capacitor keyboard window events; null until one first fires, so
  // the visualViewport fallback owns the value until then.
  const nativeOpen = ref<boolean | null>(null);
  // From the visualViewport height heuristic.
  const viewportOpen = ref(false);

  const keyboardOpen = computed(() => nativeOpen.value ?? viewportOpen.value);

  if (typeof window === 'undefined') {
    return readonly(viewportOpen);
  }

  // (1) Capacitor Keyboard plugin window events (present only in the native
  // shell that ships the plugin). Harmless everywhere else — they never fire.
  const onShow = () => {
    nativeOpen.value = true;
  };
  const onHide = () => {
    nativeOpen.value = false;
  };
  window.addEventListener('keyboardWillShow', onShow);
  window.addEventListener('keyboardWillHide', onHide);
  onScopeDispose(() => {
    window.removeEventListener('keyboardWillShow', onShow);
    window.removeEventListener('keyboardWillHide', onHide);
  });

  // (2) visualViewport height fallback.
  const vv = window.visualViewport;
  if (vv) {
    const update = () => {
      viewportOpen.value = window.innerHeight - vv.height > KEYBOARD_MIN_HEIGHT;
    };
    update();
    vv.addEventListener('resize', update);
    onScopeDispose(() => vv.removeEventListener('resize', update));
  }

  return readonly(keyboardOpen) as Readonly<Ref<boolean>>;
}
