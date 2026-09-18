/**
 * Router-aware OS deep-link handling (idss #1492 story 34, #532).
 *
 * The native shells (Android intent-filter, iOS CFBundleURLTypes, Electron
 * protocol client) deliver a raw `matou://…` URL into the WebView; this module
 * turns it into a navigation:
 *
 *  - a sign-in link opens the approve card (`signin-approve`), reusing the same
 *    link → route mapping the in-app scanner uses (useSigninScan);
 *  - a pairing link lands on the onboarding link-device screen with the payload
 *    stashed so the screen can pre-fill it (consumePendingPairLink), the way a
 *    cold-start push tap is replayed (usePush.consumePushDeepLinkTarget);
 *  - anything malformed is ignored — the app stays on its normal home rather
 *    than flashing a half-parsed card.
 *
 * The Capacitor App plugin + Electron IPC wiring lives in the `deeplink` boot
 * file, which calls setDeepLinkRouter() then ensureDeepLinkListeners().
 */

import type { Router } from 'vue-router';
import { classifyDeepLink } from 'src/lib/deepLink';
import { signinLinkToLocation } from 'src/composables/useSigninScan';
import { getAppPlugin } from 'src/lib/capacitor';
import { useOnboardingStore } from 'src/stores/onboarding';

let router: Router | null = null;

/**
 * A pairing link opened before the link-device screen was mounted. Consumed by
 * LinkDeviceScanScreen on mount; null when there is nothing pending.
 */
let pendingPairPayload: string | null = null;

/** Wire the router used for deep-link navigation. Called from the boot file. */
export function setDeepLinkRouter(r: Router): void {
  router = r;
}

/**
 * Route a raw `matou://…` URL. Safe to call before the router is wired (the nav
 * is simply dropped) and on any platform.
 */
export async function handleDeepLink(url: string): Promise<void> {
  const kind = classifyDeepLink(url);

  if (kind === 'signin') {
    const location = signinLinkToLocation(url.trim());
    if (location && router) await router.push(location);
    return;
  }

  if (kind === 'pair') {
    // The pairing flow lives inside onboarding (a store-driven screen, not a
    // route), so stash the payload and steer the onboarding store to the
    // link-device screen; the screen pre-fills it from consumePendingPairLink.
    pendingPairPayload = url.trim();
    const onboarding = useOnboardingStore();
    onboarding.setPath('link');
    onboarding.navigateTo('link-scan');
    if (router) await router.push('/');
    return;
  }

  // Unknown / malformed: do nothing. The app keeps showing its normal home.
}

/**
 * Consume a pairing link stashed by a deep-link open, or null when there is
 * none. Clears the stash so it is applied at most once.
 */
export function consumePendingPairLink(): string | null {
  const payload = pendingPairPayload;
  pendingPairPayload = null;
  return payload;
}

/**
 * Register the platform deep-link sources. Idempotent-ish: safe to call once
 * from the boot file. No-op on plain web (neither shell present).
 *
 *  - Electron: the main process forwards the OS `open-url` / `second-instance`
 *    events and the cold-start argv over the `deep-link` IPC channel.
 *  - Capacitor: the `@capacitor/app` plugin reports the launch URL (cold start)
 *    and every later `appUrlOpen` (warm).
 */
export function ensureDeepLinkListeners(): void {
  const electron = (window as unknown as { electronAPI?: { onDeepLink?: (cb: (url: string) => void) => void } })
    .electronAPI;
  if (electron?.onDeepLink) {
    electron.onDeepLink((url) => {
      void handleDeepLink(url);
    });
  }

  const appPlugin = getAppPlugin();
  if (appPlugin) {
    void appPlugin
      .getLaunchUrl()
      .then((res) => {
        if (res?.url) void handleDeepLink(res.url);
      })
      .catch(() => {
        /* no launch URL — a normal cold start */
      });
    void appPlugin.addListener('appUrlOpen', (event) => {
      if (event?.url) void handleDeepLink(event.url);
    });
  }
}

/** Reset module state — test-only seam. */
export function __resetDeepLinkForTest(): void {
  router = null;
  pendingPairPayload = null;
}
