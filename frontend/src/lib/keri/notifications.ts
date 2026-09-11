/**
 * Helpers for consuming KERIA notifications safely when two signify clients
 * share one KERIA agent (the linked-device model — spec §3.5 of the
 * linked-device sign-in design, issue #466). Both clients list the same
 * notifications, so a naive act-then-mark handler can run the same write twice:
 * a duplicate multisig signature, or a second IPEX admit on an already-admitted
 * grant. This affects stewards and admins only; ordinary members have no
 * notification-driven writes after approval.
 *
 * The invariant is idempotency on the OPERATION, not on the notification:
 *   - multisig: skip if the acting member is already a signer of the group
 *     ({@link isAlreadyGroupSigner})
 *   - IPEX admit: skip if the credential SAID is already in the wallet
 *     ({@link isGrantAlreadyAdmitted})
 *
 * {@link claimNotification} is only an optimisation on top: it marks the note
 * read, re-reads the authoritative notification list (the shared poll cache can
 * be up to ~15s stale) and reports whether the note now reads as handled by us.
 * KERIA has no compare-and-set, so this NARROWS the two-client race; it does
 * not close it. Callers whose operation is a real write MUST still guard it
 * with an idempotency check — and, so a failed write still retries on the next
 * cycle, keep marking read only AFTER the write succeeds (act-then-mark) rather
 * than routing that write through claimNotification.
 */
import { createLogger } from 'src/lib/logging';

const log = createLogger('KERINotifications');

/** The subset of a KERIA notification these helpers read. */
export interface ClaimableNote {
  i: string; // notification id
  r: boolean; // read flag
  a?: { r?: string; d?: string; [key: string]: unknown };
}

/** The subset of `SignifyClient` {@link claimNotification} depends on. */
export interface NotificationClient {
  notifications(): {
    list(start?: number, end?: number): Promise<{ notes?: ClaimableNote[] }>;
    // signify-ts resolves to the marked id; the value is unused here.
    mark(notificationId: string): Promise<unknown>;
  };
}

/**
 * One entry of KERIA's credential query (`POST /credentials/query`). `status`
 * is the credential's TEL state: `et` is the ilk of its latest TEL event
 * (`iss`/`bis` issued, `rev`/`brv` revoked) and `s` that event's hex sequence
 * number (`'1'` once revoked).
 */
export interface WalletCredential {
  sad?: { d?: string; s?: string; a?: { i?: string } };
  d?: string;
  status?: { et?: string; s?: string };
}

/**
 * Query options accepted by signify-ts `credentials().list()`. `filter` is
 * KERIA's Seeker filter, keyed by CESR path (`-s` schema, `-i` issuer, `-a-i`
 * issuee, `-d` SAID); `limit` defaults to 25 on the signify-ts side, so an
 * unfiltered list silently truncates once the wallet holds more credentials.
 */
export interface CredentialListOptions {
  filter?: object;
  limit?: number;
  skip?: number;
}

/** The subset of `SignifyClient` the credential idempotency checks depend on. */
export interface CredentialListClient {
  credentials(): {
    list(kargs?: CredentialListOptions): Promise<WalletCredential[]>;
  };
}

/** TEL event ilks that mean a credential has been revoked. */
const REVOKED_TEL_ILKS = new Set(['rev', 'brv']);

/**
 * `true` when the wallet entry's TEL state says the credential is revoked.
 * Trusts the event ilk when present; falls back to the sequence number (a
 * simple registry's only post-issuance event is the revocation at `s = '1'`).
 */
export function isCredentialRevoked(cred: WalletCredential | null | undefined): boolean {
  const et = cred?.status?.et;
  if (et) return REVOKED_TEL_ILKS.has(et);
  return cred?.status?.s === '1';
}

/**
 * Upper bound on wallet entries fetched per idempotency lookup. Both lookups
 * are server-filtered to one credential SAID or one (schema, issuee) pair, so
 * the real result is a handful of rows; the bound only guards against a
 * runaway wallet.
 */
const IDEMPOTENCY_LOOKUP_LIMIT = 100;

/**
 * Claim a notification before acting on it (spec §3.5). Marks it read, re-lists
 * fresh, and returns `true` only if the note now reads as handled. On a shared
 * agent this skips notes the other client has already claimed. Suitable ONLY
 * for handlers whose action is idempotent local state (recording a message,
 * setting a reactive flag) — NOT for external writes, which must stay
 * act-then-mark so a failure retries next cycle.
 *
 * Never throws: a mark or list failure resolves to `false` (do not act), so the
 * next poll cycle re-evaluates.
 */
export async function claimNotification(
  client: NotificationClient,
  note: ClaimableNote,
): Promise<boolean> {
  const short = note.i.slice(0, 12);
  try {
    await client.notifications().mark(note.i);
  } catch (err) {
    log.debug(`mark failed for ${short}; re-checking state`, err);
  }
  try {
    const { notes } = await client.notifications().list(0, 1000);
    const fresh = (notes ?? []).find((n) => n.i === note.i);
    if (!fresh) {
      log.debug(`note ${short} gone after mark — treating as handled elsewhere`);
      return false;
    }
    if (!fresh.r) {
      log.debug(`note ${short} still unread after mark — skipping this cycle`);
      return false;
    }
    return true;
  } catch (err) {
    log.debug(`re-list failed for ${short}; skipping`, err);
    return false;
  }
}

/**
 * The SAID of the credential a `/exn/ipex/grant` exchange would admit into the
 * wallet (`exn.e.acdc.d`), or `undefined` when the shape is unexpected.
 */
export function grantCredentialSaid(
  grantExn: { exn?: { e?: { acdc?: { d?: string } } } } | null | undefined,
): string | undefined {
  return grantExn?.exn?.e?.acdc?.d;
}

/**
 * IPEX-admit idempotency: `true` when the credential this grant would admit is
 * already in our wallet, so a second admit must be skipped. Never throws — a
 * failed credential list resolves to `false` (proceed), leaving the admit's own
 * failure handling in charge.
 */
export async function isGrantAlreadyAdmitted(
  client: CredentialListClient,
  grantExn: { exn?: { e?: { acdc?: { d?: string } } } } | null | undefined,
): Promise<boolean> {
  const said = grantCredentialSaid(grantExn);
  if (!said) return false;
  try {
    // Server-filtered on the SAID: an unfiltered list is capped at 25 entries
    // by signify-ts, which would turn this check into a no-op on any wallet
    // holding more credentials than that.
    const creds = await client.credentials().list({
      filter: { '-d': said },
      limit: IDEMPOTENCY_LOOKUP_LIMIT,
    });
    const already = (creds ?? []).some((c) => (c?.sad?.d ?? c?.d) === said);
    if (already) {
      log.debug(`grant credential ${said.slice(0, 12)} already in wallet — skipping admit`);
    }
    return already;
  } catch (err) {
    log.debug('credential list failed during admit idempotency check; proceeding', err);
    return false;
  }
}

/**
 * Approval idempotency for the write-bearing steward path (issue #480, #488,
 * #466): the SAID of an ACTIVE credential of `schemaSaid` already issued to
 * `issueeAid` in this wallet (or `null` if none), so the caller can re-grant
 * that exact SAID instead of minting a duplicate. On a shared KERIA agent both
 * linked steward devices see the same wallet, so this catches an applicant
 * already issued on another device (or from a stale pending list, or from a
 * prior run that died between issue and grant). Unlike {@link
 * isGrantAlreadyAdmitted} — keyed by the credential SAID we are about to admit
 * — the issuer does not yet know the SAID, so we match on schema + issuee AID
 * (the org is the only issuer of membership credentials), ignoring revoked
 * credentials so a removed member can be re-admitted.
 *
 * Best-effort: a client-side wallet lookup, not a server-side compare-and-set,
 * so a truly simultaneous double-issue across two devices can still race (spec
 * §3.5). Never throws — a failed list resolves to `null` (proceed), leaving
 * issuance's own handling in charge.
 */
export async function findActiveIssuedCredentialSaid(
  client: CredentialListClient,
  schemaSaid: string,
  issueeAid: string,
): Promise<string | null> {
  if (!schemaSaid || !issueeAid) return null;
  try {
    // Server-filtered on (issuee, schema) — KERIA keeps a composite Seeker
    // index for exactly this pair. An unfiltered list is capped at 25 entries
    // by signify-ts, so once the org's agent holds more credentials than that
    // (every membership, endorsement and attendance credential it ever issued)
    // the applicant's entry would fall off the page and the guard would never
    // fire. The client-side equality check is kept so the result is right even
    // if a server ignored the filter.
    const creds = await client.credentials().list({
      filter: { '-a-i': issueeAid, '-s': schemaSaid },
      limit: IDEMPOTENCY_LOOKUP_LIMIT,
    });
    // A revoked credential (member removed, or an old one superseded by a
    // role re-issue) must NOT block issuance — otherwise a removed member who
    // re-applies could never be approved again.
    const active = (creds ?? []).find(
      (c) => c?.sad?.s === schemaSaid && c?.sad?.a?.i === issueeAid && !isCredentialRevoked(c),
    );
    const said = active?.sad?.d ?? null;
    if (said) {
      log.debug(
        `credential ${schemaSaid.slice(0, 12)} already issued to ${issueeAid.slice(0, 12)} (SAID ${said.slice(0, 12)}) — re-grant instead of re-issue`,
      );
    }
    return said;
  } catch (err) {
    log.debug('credential list failed during issuance idempotency check; proceeding', err);
    return null;
  }
}

/**
 * Boolean form of {@link findActiveIssuedCredentialSaid}: `true` when an active
 * credential of `schemaSaid` has already been issued to `issueeAid`. Retained
 * for callers that only need the yes/no answer.
 */
export async function isCredentialAlreadyIssued(
  client: CredentialListClient,
  schemaSaid: string,
  issueeAid: string,
): Promise<boolean> {
  return (await findActiveIssuedCredentialSaid(client, schemaSaid, issueeAid)) !== null;
}

/**
 * Multisig idempotency: `true` when one of the acting member's current signing
 * keys (`memberKeys`) is already among the group's current signing keys
 * (`groupKeys`) — i.e. we have already joined/co-signed this group and must not
 * sign again. Pure; the caller fetches the two key states.
 */
export function isAlreadyGroupSigner(
  groupKeys: string[] | undefined,
  memberKeys: string[] | undefined,
): boolean {
  const gk = groupKeys ?? [];
  const mk = memberKeys ?? [];
  return mk.length > 0 && mk.some((k) => gk.includes(k));
}
