import { boot } from 'quasar/wrappers';

// Self-host the app font (Roboto) so onboarding and in-app screens render the
// same family and weight scale on every platform — including the Android
// WebView, where the previous delivery diverged (#370).
//
// Quasar's `roboto-font` extra shipped Roboto as plain `.woff` with no
// `font-display` (defaults to `block`), so on a cold launch the first screens
// (splash/onboarding) painted fallback/invisible text until the font finished
// loading. On the slow-to-paint Android WebView that flash was visible, making
// onboarding look like a different typeface from the already-loaded dashboard.
//
// `@fontsource/roboto` provides the same `Roboto` family via `.woff2`
// (smaller/faster) with `font-display: swap`, so text paints immediately in the
// fallback and swaps to Roboto without a blocking gap — applied consistently
// across the whole app instead of relying on load timing. We import only the
// weights the app already used (300/400/500/700) so the in-app weight scale is
// unchanged; the `roboto-font` extra is dropped in quasar.config.ts to avoid
// double-declaring the family.
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';

export default boot(() => {
  // Side-effect CSS imports above register the @font-face rules; no runtime
  // wiring needed.
});
