/**
 * Linked-device pairing link recognition (#473, #532).
 *
 * The existing device shows a `matou://pair?…` code (QR + copyable text,
 * `internal/pairing/qr.go`); the joining device reads it — from the in-app
 * scanner, a pasted string, or (with #532) the OS opening the link. This is the
 * cheap client-side shape check shared by all three entry points, mirroring
 * `isSigninLink` for the sign-in scheme: a pairing link must carry the session
 * id (`id`), the peer public key (`pk`) and its signature (`s`). A random string
 * is rejected here rather than round-tripping to the backend.
 */

/** The `matou://pair?…` scheme + host the pairing flow answers. */
export const PAIRING_PREFIX = 'matou://pair?';

/**
 * Whether `text` is a well-formed pairing link. The backend parses and verifies
 * the payload (`internal/pairing/qr.go`); this only gates obvious junk out of
 * the scan/paste/deep-link paths.
 */
export function isPairingLink(text: string): boolean {
  if (!text.startsWith(PAIRING_PREFIX)) return false;
  const params = new URLSearchParams(text.slice(PAIRING_PREFIX.length));
  return !!(params.get('id') && params.get('pk') && params.get('s'));
}
