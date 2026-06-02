/**
 * Helpers for reasoning about CESR SAIDs (self-addressing identifiers).
 */

/** qb64 length of a Blake3-256 SAID (the derivation KERI/ACDC uses by default). */
export const SAID_QB64_LENGTH = 44;

/** Base64url alphabet used by CESR qb64 primitives. */
const QB64_CHAR = /^[A-Za-z0-9_-]+$/;

/**
 * True when `value` looks like a real credential SAID, as opposed to an empty
 * string or a placeholder (e.g. `"pending"`) that gets written into a member's
 * profile during approval, before the credential SAID has actually been issued
 * and synced.
 *
 * Passing a non-SAID to KERIA's `credentials().get/revoke` causes a 500
 * (`GET /credentials/pending`), so callers should use this to decide whether to
 * trust a stored SAID or look the credential up by schema + subject AID instead.
 */
export function isLikelyCredentialSaid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === SAID_QB64_LENGTH &&
    QB64_CHAR.test(value)
  );
}
