/**
 * Deep-link boot (idss #1492 story 34, #532): wire the router the OS deep-link
 * handler navigates with, then register the platform sources.
 *
 * Plain web is a no-op — ensureDeepLinkListeners() only attaches where a native
 * shell is present (Electron IPC, or the Capacitor App plugin). The scheme is
 * claimed natively (Android intent-filter, iOS CFBundleURLTypes, Electron
 * setAsDefaultProtocolClient); this only turns the delivered URL into a route.
 */

import { boot } from 'quasar/wrappers';
import { setDeepLinkRouter, ensureDeepLinkListeners } from 'src/composables/useDeepLink';

export default boot(({ router }) => {
  setDeepLinkRouter(router);
  ensureDeepLinkListeners();
});
