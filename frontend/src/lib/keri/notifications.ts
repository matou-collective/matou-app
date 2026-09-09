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

/** The subset of `SignifyClient` the credential idempotency check depends on. */
export interface CredentialListClient {
  credentials(): {
    list(): Promise<Array<{ sad?: { d?: string }; d?: string }>>;
  };
}

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
    const creds = await client.credentials().list();
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
