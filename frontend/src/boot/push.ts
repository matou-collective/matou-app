/**
 * Push boot: wire the router used for notification-tap deep-links and register
 * the plugin listeners so a background/foreground push is handled even before
 * the user reaches a component that pulls in usePush.
 *
 * ensurePushListeners() also installs the lifecycle watchers, one of which
 * re-registers the FCM token as soon as an onboarded identity is active — the
 * app-start refresh that keeps the relay's TTL from pruning a live device
 * (docs/architecture/08-push-notifications.md §7). It never prompts: permission
 * is only ever requested after onboarding, from useOnboarding/OnboardingPage or
 * the settings toggle.
 *
 * No-op off the Android Capacitor shell — ensurePushListeners() bails when the
 * native PushNotifications plugin isn't present (web/Electron, or a shell built
 * before the Capacitor/Firebase slice).
 */

import { boot } from 'quasar/wrappers';
import { setPushRouter, ensurePushListeners, isPushPlatform } from 'src/composables/usePush';

export default boot(({ router }) => {
  // Set before the listeners: the eligibility check reads the current route to
  // recognise a returning member who lands straight in the dashboard.
  setPushRouter(router);
  if (isPushPlatform()) {
    ensurePushListeners();
  }
});
