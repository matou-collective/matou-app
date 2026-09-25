/**
 * The attribute block a Membership credential carries, per backend.
 *
 * A legacy (coa-shared Mātou) backend issues under the Mātou Membership schema:
 * `{communityName: 'MATOU', role: <app role>, joinedAt}`. An IDSS community
 * issues under its OWN Membership schema (idss `internal/credschema`
 * `membershipSchema()`), which is CLOSED (`additionalProperties: false`):
 *
 *   required  d, i, dt (signify-ts fills dt), communityName (the community's
 *             display name), preferred_username (handle), name (display name),
 *             role ∈ {operator, member}
 *   optional  email (format email), display (DDR 0217 — never sent here)
 *
 * Sending the Mātou body to an IDSS gateway is refused with a 400
 * ("'Member' is not one of ['operator', 'member']"), and `joinedAt` is not a
 * property of the IDSS schema at all. The IDSS body mirrors idss's own
 * reference issuance, `app/src/lib/stewardApprove.ts` `attributes()`.
 *
 * Pure: the caller resolves the backend from the descriptor and passes it in.
 */

/** The IDSS membership roles (idss credschema.RoleOperator / RoleMember). */
export const IDSS_ROLE_OPERATOR = 'operator';
export const IDSS_ROLE_MEMBER = 'member';
export type IdssMembershipRole = typeof IDSS_ROLE_OPERATOR | typeof IDSS_ROLE_MEMBER;

/** Which Membership schema this community issues under. */
export type MembershipBackend =
  | { kind: 'idss'; communityName: string }
  | { kind: 'legacy' };

/** Who the Membership credential is issued to. */
export interface MembershipSubject {
  aid: string;
  /** Display name (IDSS `name`). */
  name?: string;
  /** A handle already chosen for the member (IDSS `preferred_username`). */
  preferredUsername?: string;
  email?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when `email` is a plausible address (the schema's `format: email`). */
export function isValidEmail(email: string | undefined | null): email is string {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

/**
 * Map an app role onto the IDSS enum. A steward-class role — the ones the app
 * treats as admin in `checkAdminStatus` (anything naming steward / admin /
 * founding, which covers IDSS_STEWARD_APP_ROLE 'Founding Member') or an
 * already-IDSS `operator` — is `operator`; every other role is `member`.
 */
export function idssMembershipRole(appRole: string): IdssMembershipRole {
  const r = (appRole || '').trim().toLowerCase();
  if (
    r === IDSS_ROLE_OPERATOR ||
    r.includes('steward') ||
    r.includes('admin') ||
    r.includes('founding')
  ) {
    return IDSS_ROLE_OPERATOR;
  }
  return IDSS_ROLE_MEMBER;
}

const MACRONS: Record<string, string> = { ā: 'a', ē: 'e', ī: 'i', ō: 'o', ū: 'u' };

/** Lowercase, fold macrons, whitespace → '-', strip anything outside [a-z0-9._-]. */
function sanitiseHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[āēīōū]/g, (c) => MACRONS[c] ?? c)
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
}

/**
 * The member's handle (`preferred_username`). Mirrors idss's founding
 * derivation (`usernameFromOperator`: the e-mail local part, else the name
 * lowercased with spaces → '-'): an explicit handle first, then the e-mail
 * local part, then the name, each sanitised to [a-z0-9._-]; never empty — the
 * last resort is the AID's first 8 characters.
 */
export function idssPreferredUsername(subject: MembershipSubject): string {
  const candidates = [
    subject.preferredUsername,
    isValidEmail(subject.email) ? subject.email.trim().split('@')[0] : undefined,
    subject.name,
  ];
  for (const c of candidates) {
    const h = c ? sanitiseHandle(c) : '';
    if (h) return h;
  }
  return sanitiseHandle(subject.aid.slice(0, 8)) || 'member';
}

/**
 * The Membership credential's attribute block (without `i`, which the issuer
 * adds, and `dt`, which signify-ts fills). `appRole` is the app's role string
 * ('Member' on approve, the new role on a role change).
 */
export function buildMembershipAttributes(
  backend: MembershipBackend,
  subject: MembershipSubject,
  appRole: string,
  now: Date = new Date(),
): Record<string, unknown> {
  if (backend.kind === 'legacy') {
    // The Mātou schema requires communityName to be the 'MATOU' literal.
    return {
      communityName: 'MATOU',
      role: appRole,
      joinedAt: now.toISOString(),
    };
  }
  const name = (subject.name || '').trim();
  const preferredUsername = idssPreferredUsername(subject);
  return {
    communityName: backend.communityName,
    preferred_username: preferredUsername,
    name: name || preferredUsername,
    role: idssMembershipRole(appRole),
    ...(isValidEmail(subject.email) ? { email: subject.email.trim() } : {}),
  };
}
