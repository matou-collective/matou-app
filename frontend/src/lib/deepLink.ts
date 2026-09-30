/**
 * OS deep-link classification (idss #1492 story 34, #532).
 *
 * The app claims the `matou://` scheme on Android, iOS and the Electron desktop
 * build (intent-filter / CFBundleURLTypes / setAsDefaultProtocolClient). When
 * the OS opens such a link the native shell hands the raw URL to the WebView,
 * and this pure function decides where it belongs before anything acts on it:
 *
 *  - `matou://signin?…`  the wallet's approve card (the sign-in page's "Open my
 *                        community app" button and its QR carry this). A locked
 *                        control panel's unlock is one of these too — the code
 *                        says it is an unlock (#688).
 *  - `matou://pair?…`    the existing linked-device pairing link — routed to the
 *                        link-device screen, never the sign-in card.
 *  - `matou://inbox`     the IDSS steward hand-off link (#599) — routed to the
 *                        steward's pending approvals. Carries nothing trusted;
 *                        a trailing `/` and an optional query are tolerated.
 *  - anything else       unknown: the app stays on its normal home rather than
 *                        rendering a half-parsed card off a malformed link.
 *
 * Keeping the discriminator pure (and separate from the router-aware
 * {@link useDeepLink} handler) makes it unit-testable without the shell.
 */

import { isSigninLink } from 'src/lib/signin/link';
import { isPairingLink } from 'src/lib/pairing/link';
import { isInboxLink } from 'src/lib/inbox/link';

/** What an incoming `matou://…` link resolves to. */
export type DeepLinkKind = 'signin' | 'pair' | 'inbox' | 'unknown';

/**
 * Put a raw deep-link URL in the canonical `matou://<host>?…` form the link
 * parsers read: trimmed, and with a `/` straight after the host dropped.
 * Windows inserts that slash when it hands a custom-scheme link to the app —
 * the page's `matou://signin?c=…` arrives as `matou://signin/?c=…` — and
 * without this every sign-in and pairing link opened on Windows was ignored.
 */
export function normalizeDeepLink(raw: string): string {
  return (raw ?? '').trim().replace(/^(matou:\/\/[a-z]+)\/(?=[?#]|$)/i, '$1');
}

/**
 * Classify a raw deep-link URL. Never throws on member/OS input; whitespace is
 * tolerated and anything that is not a recognised, well-formed link is
 * `'unknown'`.
 */
export function classifyDeepLink(raw: string): DeepLinkKind {
  const text = normalizeDeepLink(raw);
  if (isSigninLink(text)) return 'signin';
  if (isPairingLink(text)) return 'pair';
  if (isInboxLink(text)) return 'inbox';
  return 'unknown';
}
