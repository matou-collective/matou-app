/**
 * Choosing and describing the credential the door asked for, and trimming the
 * exported CESR to what the door reads (idss spec #1492 stories 13/14, ADR
 * 0236 §2 present-as-holder, prototype #1301 `wallet/wallet.mjs`).
 *
 * The wallet holds the member's identity and every credential their community
 * issued them. A sign-in ask names schema SAID(s); the wallet finds the held
 * credential of that kind issued to this member, renders the single-match line
 * "What will be shown", and on Approve exports just the ACDC and its issuance
 * event — the door verifies against the issuer's witnessed ledger it fetches
 * itself, so the rest of the `includeCESR` export is noise to it.
 */

/** The subset of a signify-ts credential record the card and export need. The
 * full record carries much more; we read only `sad`. */
export interface HeldCredential {
  sad?: {
    /** The credential SAID. */
    d?: string;
    /** The schema SAID. */
    s?: string;
    /** The issuer AID. */
    i?: string;
    /** The attribute block. */
    a?: {
      /** The issuee (holder) AID. */
      i?: string;
      /** The role encoded in the credential (e.g. "Member"). */
      role?: string;
      /** The issuance timestamp (ISO-8601). */
      dt?: string;
      [k: string]: unknown;
    };
  };
}

/** The single-match "What will be shown" view model (spec story 13). */
export interface CredentialToShow {
  /** The credential SAID (for the details disclosure only). */
  said: string;
  /** The schema SAID it matched. */
  schema: string;
  /** The human kind label, e.g. "Membership". */
  kindLabel: string;
  /** The role encoded in the credential, e.g. "Member". */
  role: string;
  /** The issuance date, formatted "12 Aug 2026" (empty when unknown). */
  issuedOn: string;
}

/**
 * Find the held credential matching the door's ask: schema in the requested
 * set (or, when the ask names none, the sole/first credential — the prototype's
 * fallback) and issued to this member. Returns `undefined` when nothing fits.
 *
 * v1 never surfaces a picker — one community issues one Membership — so this
 * returns the first match; a multi-match picker is out of scope for #531.
 */
export function chooseCredential(
  creds: readonly HeldCredential[],
  schemas: readonly string[],
  holderAid: string,
): HeldCredential | undefined {
  const wantSchema = (c: HeldCredential) => schemas.length === 0 || schemas.includes(c.sad?.s ?? '');
  const heldByHolder = (c: HeldCredential) => {
    const issuee = c.sad?.a?.i;
    // An ask with no holder context, or a credential with no recorded issuee,
    // is not filtered out — the door makes the final holder check (ADR 0236 §1
    // rule vi). We only avoid presenting someone else's credential when we can.
    return !holderAid || !issuee || issuee === holderAid;
  };
  return creds.find((c) => wantSchema(c) && heldByHolder(c));
}

/** Known credential-kind labels; anything else is title-cased from its key. */
const KIND_LABELS: Record<string, string> = {
  membership: 'Membership',
  committee: 'Committee',
};

/**
 * Describe a chosen credential for the "What will be shown" line. `schemaKinds`
 * maps schema SAID → descriptor kind key (e.g. "membership") so the label reads
 * as the community named it; an unknown schema falls back to a generic label.
 */
export function describeCredential(
  cred: HeldCredential,
  schemaKinds: Record<string, string> = {},
): CredentialToShow {
  const sad = cred.sad ?? {};
  const schema = sad.s ?? '';
  const kindKey = schemaKinds[schema] ?? '';
  const kindLabel = kindLabelFor(kindKey);
  return {
    said: sad.d ?? '',
    schema,
    kindLabel,
    role: (sad.a?.role ?? '').trim(),
    issuedOn: formatIssueDate(sad.a?.dt),
  };
}

function kindLabelFor(kindKey: string): string {
  if (!kindKey) return 'Membership';
  return KIND_LABELS[kindKey.toLowerCase()] ?? titleCase(kindKey);
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (m) => m.toUpperCase());
}

/** Format an ISO-8601 issuance timestamp as "12 Aug 2026"; "" when unparseable. */
export function formatIssueDate(dt: string | undefined): string {
  if (!dt) return '';
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Version string of a CESR/ACDC message: `{"v":"KERI10JSON0001a3_"…` or
// `{"v":"ACDC10JSON…`. Tolerant of any minor generation (`[0-9A-Fa-f]{2}`) so a
// newer keripy's framing still trims (prototype #1301 used the same shape).
const MSG_RE = /\{"v":"(?:KERI|ACDC)[0-9A-Fa-f]{2}JSON([0-9a-f]{6})_"/g;

/**
 * Trim a full `includeCESR` export down to the two messages the door reads: the
 * ACDC and its `iss` issuance event (prototype #1301 `trimToCredential`). The
 * door recomputes SAIDs and walks the witnessed ledger itself, so the issuer's
 * KEL, the holder's KEL, the registry inception and every signature attachment
 * in the export are dropped. When the stream does not yield both, the original
 * is returned unchanged — the door also accepts the full stream (ADR 0236 §2).
 */
export function trimPresentation(stream: string): string {
  const keep: string[] = [];
  let m: RegExpExecArray | null;
  MSG_RE.lastIndex = 0;
  while ((m = MSG_RE.exec(stream)) !== null) {
    const size = parseInt(m[1]!, 16);
    const msg = stream.slice(m.index, m.index + size);
    let parsed: { t?: string; v?: string };
    try {
      parsed = JSON.parse(msg) as { t?: string; v?: string };
    } catch {
      MSG_RE.lastIndex = m.index + size;
      continue;
    }
    // The ACDC has no `t` and a version string starting `ACDC`; the issuance
    // event is `t === "iss"`. Nothing else is kept.
    if (parsed.t === 'iss' || (!parsed.t && (parsed.v ?? '').startsWith('ACDC'))) {
      keep.push(msg);
    }
    MSG_RE.lastIndex = m.index + size;
  }
  return keep.length === 2 ? keep.join('') : stream;
}
