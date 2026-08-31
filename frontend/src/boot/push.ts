/**
 * Push boot: wire the router used for notification-tap deep-links and register
 * the plugin listeners so a background/foreground push is handled even before
 * the user reaches a component that pulls in usePush.
 *
 * No-op off the Android Capacitor shell — ensurePushListeners() bails when the
 * native PushNotifications plugin isn't present (web/Electron, or a shell built
 * before the Capacitor/Firebase slice). Permission is NOT requested here; that
 * happens only after onboarding (docs/architecture/08-push-notifications.md §7).
 */

import { boot } from 'quasar/wrappers';
import { setPushRouter, ensurePushListeners, isPushPlatform } from 'src/composables/usePush';

export default boot(({ router }) => {
  setPushRouter(router);
  if (isPushPlatform()) {
    ensurePushListeners();
  }
});
