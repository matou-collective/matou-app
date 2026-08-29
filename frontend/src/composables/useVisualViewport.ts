import { ref, readonly, onScopeDispose, type Ref } from 'vue';

/**
 * Reactive height (px) of the visual viewport — the part of the page actually
 * visible to the user, excluding UI the browser overlays on top such as the
 * on-screen keyboard.
 *
 * When the soft keyboard opens on mobile, modern Chromium/WebView shrinks the
 * *visual* viewport (`window.visualViewport.height`) while the *layout*
 * viewport (and therefore `100vh`) stays at its full pre-keyboard size. That
 * mismatch is why a fixed-`100vh` chat column keeps its height and pushes its
 * top content behind the keyboard — see #125. Tracking `visualViewport.height`
 * lets a component size itself to the space the user can actually see.
 *
 * Returns `null` when there is nothing to track — SSR, or a browser without the
 * `visualViewport` API — so callers can fall back to their static CSS height.
 *
 * The `resize` listener is removed automatically when the owning effect scope
 * (component `setup`, or an explicit `effectScope`) is disposed.
 */
export function useVisualViewport(): Readonly<Ref<number | null>> {
  const height = ref<number | null>(null);

  if (typeof window === 'undefined' || !window.visualViewport) {
    return readonly(height);
  }

  const vv = window.visualViewport;

  const update = () => {
    height.value = vv.height;
  };
  update();

  // Only `resize` changes the height; `scroll` shifts offsetTop but not height,
  // so it is not needed here.
  vv.addEventListener('resize', update);
  onScopeDispose(() => vv.removeEventListener('resize', update));

  return readonly(height);
}
