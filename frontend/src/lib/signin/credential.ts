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

import { credentialTitle, titleCaseCommittee } from 'src/lib/credentialAppearance';
import { STEWARD_ROLE } from 'src/lib/spaces/steward';
import {
  credentialCardServiceName,
  credentialStatusLabel,
  isRevokedStatus,
  toWalletCredential,
  type WalletCredential,
} from 'src/lib/walletCredential';
import { isRememberedRevoked } from './revokedMemory';

/** The subset of a signify-ts credential record the card and export need. The
 * full record carries much more; we read `sad`, and for the card the schema and
 * status the agent returned beside it. */
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
      /**
       * The definition slug a committee-schema credential carries (e.g.
       * `administrator`, `finance`). It is what tells one credential of the
       * shared committee schema from another, and what a door names in `cred=`.
       */
      committee?: string;
      [k: string]: unknown;
    };
  };
  /** The credential's schema as the agent holds it (for the card's title). */
  schema?: { title?: string; description?: string };
  /** The credential's standing as the agent last read it (`et: 'rev'` = revoked). */
  status?: { s?: string; et?: string };
}

/** The single-match "What will be shown" view model (spec story 13). */
export interface CredentialToShow {
  /** The credential SAID (for the details disclosure only). */
  said: string;
  /** The schema SAID it matched. */
  schema: string;
  /** The human kind label, e.g. "Membership". */
  kindLabel: string;
  /**
   * The credential's own name — the name on its card: the name its community
   * gave it (`a.display.name`), else its title-cased slug ("Administrator"),
   * else its schema's title, else the kind label. A committee-schema credential
   * is named by this, never by its shared kind.
   */
  name: string;
  /** The definition slug a komiti credential carries (`a.committee`, e.g.
   *  `administrator`); blank for a Membership. */
  slug: string;
  /** The role encoded in the credential, e.g. "Member". */
  role: string;
  /** The issuance date, formatted "12 Aug 2026" (empty when unknown). */
  issuedOn: string;
  /** The credential as the card the approve screen draws (#683). */
  card: CredentialCardModel;
}

/**
 * Find the held credential matching the door's ask, issued to this member.
 * Returns `undefined` when nothing fits.
 *
 * When the ask **names a credential** (`credential`, the `cred=` slug — idss ADR
 * 0289, #683) the match is the live held credential whose schema is asked AND
 * whose `a.committee` equals that slug. The schema cannot name it: Administrator
 * shares the committee schema with every komiti credential, so a member holding
 * Finance and Administrator must never present Finance.
 *
 * There is ONE fallback, and only for `administrator` (app-door-golden
 * `panel.administrator.wallet_rule`; Ben, 2026-09-28): a wallet holding no
 * Administrator presents its **Membership whose role is `operator`** — the
 * founding operator and any steward still on the legacy role, whom the gateway
 * admits on that Membership until idss #1956 retires `role`. A Membership with
 * any other role is not presented at that door, no other komiti credential is
 * ever a fallback, and any other named credential is that credential or nothing.
 *
 * When the ask names none, the match is what it always was: the first held
 * credential whose schema is in the requested set (or, when the ask names no
 * schema either, the sole/first credential — the prototype's fallback). v1 never
 * surfaces a picker — one community issues one Membership.
 */
export function chooseCredential(
  creds: readonly HeldCredential[],
  schemas: readonly string[],
  holderAid: string,
  credential?: string,
): HeldCredential | undefined {
  const named = (credential ?? '').trim();
  if (!named) return creds.find((c) => isAsked(c, schemas, holderAid));

  // A revoked credential is passed over, so one that was revoked and issued
  // again presents the live one rather than being refused on the dead one.
  const asked = creds.find((c) => isAsked(c, schemas, holderAid) && !isRevoked(c) && credentialSlug(c) === named);
  if (asked || named !== ADMINISTRATOR_SLUG) return asked;

  // The one fallback: the operator's Membership.
  return creds.find((c) => isOperatorMembership(c, schemas, holderAid));
}

/** The slug the control panel's door names (idss `credschema.AdministratorSlug`). */
export const ADMINISTRATOR_SLUG = 'administrator';

/** Whether a credential is of an asked schema (any, when the ask names none)
 *  and, as far as the wallet can tell, this member's own. */
function isAsked(cred: HeldCredential, schemas: readonly string[], holderAid: string): boolean {
  if (schemas.length > 0 && !schemas.includes(cred.sad?.s ?? '')) return false;
  const issuee = cred.sad?.a?.i;
  // An ask with no holder context, or a credential with no recorded issuee,
  // is not filtered out — the door makes the final holder check (ADR 0236 §1
  // rule vi). We only avoid presenting someone else's credential when we can.
  return !holderAid || !issuee || issuee === holderAid;
}

/**
 * Whether `cred` is this member's live **operator Membership** of an asked
 * schema: the credential the control panel's door admits in Administrator's
 * place, and the one a steward's standing rests on. A credential carrying a
 * committee slug is a komiti credential, never a Membership, whatever role it
 * claims.
 */
export function isOperatorMembership(
  cred: HeldCredential,
  schemas: readonly string[],
  holderAid: string,
): boolean {
  return (
    isAsked(cred, schemas, holderAid) &&
    !isRevoked(cred) &&
    !credentialSlug(cred) &&
    (cred.sad?.a?.role ?? '').trim().toLowerCase() === STEWARD_ROLE
  );
}

/** The definition slug a komiti credential carries (`a.committee`); blank for
 *  a Membership. */
export function credentialSlug(cred: HeldCredential): string {
  const slug = cred.sad?.a?.committee;
  return typeof slug === 'string' ? slug.trim() : '';
}

/**
 * Whether this credential is revoked, as far as the wallet knows: the agent
 * last read it as revoked, or a sign-in door answered `revoked` when it was
 * presented this session (#690). The door reads the witnessed ledger; the
 * agent's record is as old as the day the credential was admitted.
 */
function isRevoked(cred: HeldCredential): boolean {
  return (
    cred.status?.et === 'rev' ||
    isRevokedStatus(String(cred.status?.s ?? '')) ||
    isRememberedRevoked(cred.sad?.d)
  );
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
 * `community` is the name the sign-in code carried, for the card of a
 * credential that names no community itself.
 */
export function describeCredential(
  cred: HeldCredential,
  schemaKinds: Record<string, string> = {},
  community = '',
): CredentialToShow {
  const sad = cred.sad ?? {};
  const schema = sad.s ?? '';
  const kindKey = schemaKinds[schema] ?? '';
  const kindLabel = kindLabelFor(kindKey);
  const card = credentialCard(cred, schemaKinds, community);
  return {
    said: sad.d ?? '',
    schema,
    kindLabel,
    name: card.name,
    slug: credentialSlug(cred),
    role: (sad.a?.role ?? '').trim(),
    issuedOn: formatIssueDate(sad.a?.dt),
    card,
  };
}

/**
 * The credential about to be presented, as the card the wallet draws for it
 * (#683): its mark and the look it was issued with, its name, the community and
 * the issue date. The approve screen renders this through the wallet's own card
 * component and puts Approve at its foot, so what is pressed is visibly the
 * thing being shown.
 */
export interface CredentialCardModel {
  /** The wallet's view of the credential — its mark and its `display` look. */
  credential: WalletCredential;
  /** The card's name ("Administrator", "Membership", or the community's own). */
  name: string;
  /** The card's tag. A credential being presented is always one received. */
  tag: string;
  /** The status chip's word and tone. */
  statusLabel: string;
  statusTone: 'healthy' | 'warning';
  /** The role line, for a credential with no service slug (may be blank). */
  subtitle: string;
  /** The slug services know the credential as (blank for a legacy credential). */
  serviceName: string;
  /** The community the credential belongs to. Never blank. */
  description: string;
  /** "Issued 12 Aug 2026" (blank when the issue date is unknown). */
  footer: string;
}

/** What the approve card calls a community neither the credential nor the
 *  sign-in code names. */
export const UNNAMED_COMMUNITY = 'your community';

/**
 * Build the card for a chosen credential. `community` is the name the sign-in
 * code carried, used only when the credential itself names no community — what
 * the community signed wins over what a code claims. When neither names one the
 * card says {@link UNNAMED_COMMUNITY}, as the headline does (#688).
 */
export function credentialCard(
  cred: HeldCredential,
  schemaKinds: Record<string, string> = {},
  community = '',
): CredentialCardModel {
  const credential = toWalletCredential(asRecord(cred));
  const kindLabel = kindLabelFor(schemaKinds[credential.schemaSaid] ?? '');
  const name = credentialTitle(credential, credential.schemaTitle || kindLabel);
  const issuedOn = formatIssueDate(credential.issuedAt);
  const role = credential.role.trim();
  return {
    credential,
    name,
    tag: 'Received',
    statusLabel: credentialStatusLabel(isRevoked(cred) ? 'revoked' : credential.status),
    statusTone: isRevoked(cred) ? 'warning' : 'healthy',
    // The role line would only repeat a name that already says it.
    subtitle: role && role.toLowerCase() !== name.toLowerCase() ? role : '',
    serviceName: credentialCardServiceName(credential),
    // Always a line to draw: the approve card's contract names it (idss PU-A4,
    // `credential-issuer`). With no name from either, it says what the card's
    // headline says of a code that names no community.
    description: credential.communityName || community.trim() || UNNAMED_COMMUNITY,
    footer: issuedOn ? `Issued ${issuedOn}` : '',
  };
}

/**
 * What to call the credential a door asked for, for the no-credential screen
 * (#683): the title-cased slug when the door named one (`administrator` →
 * "Administrator"), else the kind of the first asked schema the community's
 * descriptor knows ("Membership"). Blank when the ask can be given no name.
 */
export function askedCredentialName(
  credential: string | undefined,
  schemas: readonly string[],
  schemaKinds: Record<string, string> = {},
): string {
  const named = (credential ?? '').trim();
  if (named) return titleCaseCommittee(named);
  const known = schemas.find((s) => !!schemaKinds[s]);
  return known ? kindLabelFor(schemaKinds[known]!) : '';
}

function asRecord(cred: HeldCredential): Record<string, unknown> {
  return cred as unknown as Record<string, unknown>;
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
