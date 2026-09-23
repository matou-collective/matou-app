/**
 * Steward inbox deep-link recognition (#599).
 *
 * An IDSS community running with **Members use the app only** on (idss DDR 0246
 * decisions 9/10) retires the control panel's signing: every steward act
 * becomes a hand-off — *"N applications are waiting. Open your app to approve
 * them"* — with an **Open my app** link and a QR of the same link, both
 * carrying `matou://inbox` (idss `dashboard/src/components/members/StewardHandoff.vue`).
 * The steward scans it from the laptop with their phone and should land where
 * the approvals are, not on the home screen.
 *
 * Unlike the `signin`/`pair` links this carries nothing trusted or required —
 * it is a bare "open my inbox" verb. A trailing slash and an optional query (or
 * fragment) are tolerated; no params are read. This is the cheap client-side
 * shape check the deep-link classifier shares, mirroring `isSigninLink` /
 * `isPairingLink`.
 */

/** `matou://inbox`, tolerating a trailing `/` and an optional `?query`/`#frag`. */
const INBOX_RE = /^matou:\/\/inbox\/?(?:[?#].*)?$/i;

/**
 * Whether `text` is the `matou://inbox` inbox deep-link. Never throws on OS
 * input; surrounding whitespace is tolerated.
 */
export function isInboxLink(text: string): boolean {
  return INBOX_RE.test((text ?? '').trim());
}
