import { boot } from 'quasar/wrappers';

// Self-host the kit type system so onboarding and in-app screens render the same
// families and weight scale on every platform — including the Android WebView,
// where a network-loaded font previously diverged (#370).
//
// IDSS DDR 0281 / #657: the branding is cohesive across Coa and IDSS, one type
// system on every surface — **Merriweather** for the voice/headings
// (`--oc-font-serif`) and **Roboto Mono** for UI (`--oc-font-sans`), the IDSS
// kit's fonts. These replace Roboto as the app family.
//
// `@fontsource/*` provides each family via `.woff2` with `font-display: swap`,
// so text paints immediately in the fallback and swaps in without a blocking
// gap — applied consistently across the app instead of relying on load timing.
// We import only the weights the in-app scale uses.
import '@fontsource/merriweather/400.css';
import '@fontsource/merriweather/500.css';
import '@fontsource/merriweather/700.css';
import '@fontsource/roboto-mono/300.css';
import '@fontsource/roboto-mono/400.css';
import '@fontsource/roboto-mono/500.css';
import '@fontsource/roboto-mono/700.css';

export default boot(() => {
  // Side-effect CSS imports above register the @font-face rules; no runtime
  // wiring needed.
});
