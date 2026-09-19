/**
 * OS deep-link classification (idss #1492 story 34, #532).
 *
 * The app claims the `matou://` scheme on Android, iOS and the Electron desktop
 * build (intent-filter / CFBundleURLTypes / setAsDefaultProtocolClient). When
 * the OS opens such a link the native shell hands the raw URL to the WebView,
 * and this pure function decides where it belongs before anything acts on it:
 *
 *  - `matou://signin?…`  the wallet's approve card (the sign-in page's "Open my
 *                        community app" button and its QR carry this).
 *  - `matou://pair?…`    the existing linked-device pairing link — routed to the
 *                        link-device screen, never the sign-in card.
 *  - anything else       unknown: the app stays on its normal home rather than
 *                        rendering a half-parsed card off a malformed link.
 *
 * Keeping the discriminator pure (and separate from the router-aware
 * {@link useDeepLink} handler) makes it unit-testable without the shell.
 */

import { isSigninLink } from 'src/lib/signin/link';
import { isPairingLink } from 'src/lib/pairing/link';

/** What an incoming `matou://…` link resolves to. */
export type DeepLinkKind = 'signin' | 'pair' | 'unknown';

/**
 * Classify a raw deep-link URL. Never throws on member/OS input; whitespace is
 * tolerated and anything that is not a recognised, well-formed link is
 * `'unknown'`.
 */
export function classifyDeepLink(raw: string): DeepLinkKind {
  const text = (raw ?? '').trim();
  if (isSigninLink(text)) return 'signin';
  if (isPairingLink(text)) return 'pair';
  return 'unknown';
}
