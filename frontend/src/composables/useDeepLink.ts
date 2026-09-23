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
 *  - an inbox link (#599 — the IDSS steward hand-off QR) lands on the steward's
 *    pending approvals (the Pending card on `/dashboard`, scrolled into view via
 *    `?focus=pending`). Warm, it navigates straight there; on a cold start it is
 *    stashed for the onboarding gate to replay past community-access verification
 *    (consumeInboxDeepLinkTarget), exactly as the push chat deep-link is. A
 *    non-steward, or a wallet with no community yet, simply lands on its normal
 *    home — the dashboard shows no Pending card and does not scroll;
 *  - anything malformed is ignored — the app stays on its normal home rather
 *    than flashing a half-parsed card.
 *
 * The Capacitor App plugin + Electron IPC wiring lives in the `deeplink` boot
 * file, which calls setDeepLinkRouter() then ensureDeepLinkListeners().
 */

import type { Router, RouteLocationRaw } from 'vue-router';
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

/**
 * The steward pending-approvals route stashed by a cold-start inbox deep-link
 * (`matou://inbox`), replayed by the onboarding gate past community-access
 * verification (consumeInboxDeepLinkTarget); null when there is nothing pending.
 */
let pendingInboxTarget: RouteLocationRaw | null = null;

/** The steward pending-approvals route an inbox deep-link opens. */
const INBOX_TARGET: RouteLocationRaw = { name: 'dashboard', query: { focus: 'pending' } };

/** True while the router already sits on a `/dashboard` route, where an inbox
 *  deep-link can navigate straight to the Pending card. On the splash/onboarding
 *  gate it cannot — the target is stashed for the gate to replay instead. */
function isOnDashboardRoute(): boolean {
  return (router?.currentRoute?.value?.path ?? '').startsWith('/dashboard');
}

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

  if (kind === 'inbox') {
    // Warm (already inside the app): navigate straight to the Pending card.
    // Cold start (still on the splash/onboarding gate): a direct /dashboard push
    // is bounced back by the gate, and would flash a half-built dashboard before
    // community access is verified — so stash the target for the onboarding gate
    // to replay, mirroring the push chat deep-link (consumePushDeepLinkTarget).
    if (isOnDashboardRoute()) {
      if (router) await router.push(INBOX_TARGET);
    } else {
      pendingInboxTarget = INBOX_TARGET;
      if (router) await router.push('/');
    }
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
 * Consume the steward pending-approvals route stashed by a cold-start inbox
 * deep-link, or null when there is none. Clears the stash so the onboarding
 * gate replays it at most once. The gate calls
 * `router.push(consumePushDeepLinkTarget() ?? consumeInboxDeepLinkTarget() ?? '/dashboard')`.
 */
export function consumeInboxDeepLinkTarget(): RouteLocationRaw | null {
  const target = pendingInboxTarget;
  pendingInboxTarget = null;
  return target;
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
  pendingInboxTarget = null;
}
