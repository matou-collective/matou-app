/**
 * Wallet sign-in link parsing (idss spec #1492 story 4/10, ADR 0236,
 * prototype #1301 `door/main.go` `deepLink`).
 *
 * A community sign-in page mints a challenge and encodes everything the wallet
 * needs behind one `matou://signin?…` code — the same payload sits behind the
 * page's QR and its "Open my community app" button. The wallet parses it and
 * shows the approve card (WS-A2) without ever contacting the site first.
 *
 * The link carries (the real bridge's deep-link params, app-door-golden.json
 * `deep_link_params`):
 *
 *   matou://signin?door=<site url>&c=<challenge>&present=<present url>&s=<schema SAID(s)>&name=<community>&svc=<service>[&cred=<slug>&offer=<what it offers>]
 *
 *  - `door`    the sign-in site's own address; the signature is bound to it so
 *              a signature harvested by a lookalike is worthless at the real
 *              door (ADR 0236 §5).
 *  - `c`       the challenge id, which is also the nonce the bound message
 *              signs over (one value in prototype #1301).
 *  - `present` the exact URL to POST the presentation to (the challenge
 *              descriptor's `present_url`, repeated verbatim). The wallet posts
 *              here and never derives a path from `door` (idss #1669, #574). A
 *              link with no `present` is from a door this app cannot answer, so
 *              it is refused rather than guessed at.
 *  - `s`       the schema SAID(s) the door will accept, comma-separated when
 *              more than one (v1 asks for exactly one).
 *  - `name`    the community's name, for the card headline and the site line.
 *  - `service` the OIDC client that started the hop (Files, the Portal). The
 *              prototype omitted it; the real bridge carries it (spec story 4).
 *              Read from `service` or the short `svc`, tolerated absent.
 *  - `offer`   **what this sign-in offers**, in a field of its own (idss ADR
 *              0282 as amended 2026-09-29, obligation 1a; app-door-golden
 *              `offer_field`; #688). Three values, absent being one of them:
 *              absent — an ordinary service sign-in, which offers no seat
 *              unlock; `seat-unlock` — a control-panel sign-in, so a steward is
 *              shown the unlock line (PU-A2u); `unlock` — a locked panel
 *              unlocking through this same door, so a steward is shown the
 *              approve card in its unlock form (PU-A4). The wallet reads THIS
 *              field and nothing else for it: never the display name in `svc`,
 *              never `cred`, and never a sealing key — no code carries one
 *              (`ek=` is retired; the panel binds its key at the door after it
 *              lands, and the wallet reads it there — `handover.ts`).
 *  - `cred`    the **credential the door asks for**, by its definition slug
 *              (idss ADR 0289, app-door-golden `panel.administrator`; #683). It
 *              rides ONLY a control-panel challenge, as `cred=administrator`:
 *              Administrator is issued on the committee schema, which it shares
 *              with every komiti credential, so `s` alone cannot name it. The
 *              wallet presents the held credential of an asked schema whose
 *              `a.committee` equals this slug; failing that, at this door only,
 *              an operator's Membership; failing that, nothing (see
 *              `chooseCredential`). An ordinary service sign-in carries no
 *              `cred` and is answered as it always was.
 *
 * The scanner accepts this beside the existing `matou://pair?…` pairing link;
 * `isSigninLink` is the cheap discriminator the scan/paste paths use. It is the
 * ONLY sign-in scheme: the panel's own unlock code, which had a scheme of its
 * own, is retired — a locked panel unlocks through the sign-in door (#688).
 */

/** The `matou://signin?…` scheme + host the wallet answers. */
const SIGNIN_PREFIX = 'matou://signin?';

/** The deep-link param that says what a sign-in offers (golden `offer_field`). */
export const OFFER_PARAM = 'offer';
/** A control-panel sign-in: a seat unlock is on offer (PU-A2u). */
export const OFFER_SEAT_UNLOCK = 'seat-unlock';
/** A locked panel unlocking through the sign-in door: this IS an unlock (PU-A4). */
export const OFFER_UNLOCK = 'unlock';

/** What a sign-in code can say it offers. Absent — nothing — is the third value. */
export type SigninOffer = typeof OFFER_SEAT_UNLOCK | typeof OFFER_UNLOCK;

/** One parsed sign-in ask — everything the approve card needs off the link. */
export interface SigninAsk {
  /** The sign-in site's address; the bound message signs over this. */
  door: string;
  /** The exact URL the presentation is POSTed to (the door's `present_url`,
   * carried verbatim — never derived from `door`). */
  present: string;
  /** The challenge id, which is also the nonce that is signed. */
  challenge: string;
  /** The schema SAID(s) the door accepts (v1: one). */
  schemas: string[];
  /** The community name for the headline and site line. */
  community: string;
  /** The service that started the sign-in (empty when the link omits it). */
  service: string;
  /**
   * What the code says it offers, from `offer=` (#688): `seat-unlock` on a
   * control-panel sign-in, `unlock` on an unlock. Absent (undefined) on every
   * ordinary service sign-in, and for any word this wallet does not know — it
   * arms nothing for an offer it cannot name. Read with {@link offersSeatUnlock}
   * and {@link isUnlockAsk}.
   */
  offer?: SigninOffer;
  /**
   * The definition slug of the credential the door asks for, from `cred=` (e.g.
   * `administrator` at the control panel's door — idss ADR 0289, #683). When set,
   * the wallet presents the held credential of an asked schema whose
   * `a.committee` equals it — never merely the first credential of an asked
   * schema (`chooseCredential` has the rule, and its one fallback). Absent
   * (undefined) on every service sign-in.
   */
  credential?: string;
}

/**
 * Cheap client-side shape check before the wallet acts on a scanned/opened
 * code, mirroring `isPairingPayload` in LinkDeviceScanScreen: a `matou://signin`
 * link must at least carry a `door` and a challenge `c`. A random string gets a
 * plain "not a sign-in code" rather than a half-built card.
 */
export function isSigninLink(text: string): boolean {
  if (!text.startsWith(SIGNIN_PREFIX)) return false;
  const params = new URLSearchParams(text.slice(SIGNIN_PREFIX.length));
  return !!(params.get('door') && params.get('c'));
}

/**
 * Parse a `matou://signin?…` link into a {@link SigninAsk}, or `null` when the
 * text is not a well-formed sign-in link (wrong scheme, or missing the door,
 * challenge, or `present` URL). A link with no `present` is from a door this
 * app cannot answer — it is refused honestly, never answered by guessing a
 * path from `door` (#574). Never throws on member input.
 */
export function parseSigninLink(text: string): SigninAsk | null {
  if (!isSigninLink(text)) return null;
  const params = new URLSearchParams(text.slice(SIGNIN_PREFIX.length));
  return buildAsk((key) => params.get(key) ?? '');
}

/**
 * Rebuild the ask from the approve card's route query. The scanner and the OS
 * deep-link handler both route there with the code's params carried as query
 * (`signinLinkToLocation`), so this reads the same keys {@link parseSigninLink}
 * does and yields the same ask — a repeated param takes its first value. `null`
 * when the query carries no door, challenge or `present` URL.
 */
export function signinAskFromQuery(query: Record<string, unknown>): SigninAsk | null {
  return buildAsk((key) => {
    const v = query[key];
    if (typeof v === 'string') return v;
    return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
  });
}

/** Build the ask from one param reader, shared by the link and the route query. */
function buildAsk(get: (key: string) => string): SigninAsk | null {
  const door = get('door').trim();
  const challenge = get('c').trim();
  const present = get('present').trim();
  if (!door || !challenge || !present) return null;

  // `s` is one SAID today but may be comma-separated for a multi-schema ask;
  // split, trim and drop blanks so an empty `s` yields no schema rather than [''].
  const schemas = get('s')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const community = get('name').trim();
  const service = (get('service') || get('svc')).trim();

  const ask: SigninAsk = { door, present, challenge, schemas, community, service };

  // `offer` says what the code offers, in a field of its own (#688). Carried
  // only when it is a value the golden names, so an ordinary sign-in's ask is
  // exactly the ask it was and an unknown word offers nothing.
  const offer = get(OFFER_PARAM).trim();
  if (offer === OFFER_SEAT_UNLOCK || offer === OFFER_UNLOCK) ask.offer = offer;

  // `cred` names the credential the door asks for (#683). Carried only when
  // present, so an ask with no `cred` is exactly the ask it was.
  const credential = get('cred').trim();
  if (credential) ask.credential = credential;

  return ask;
}

/** True when the code offers a seat unlock — a control-panel sign-in. A steward
 *  is shown the unlock line for these, and only these (PU-A2u). */
export function offersSeatUnlock(ask: SigninAsk): boolean {
  return ask.offer === OFFER_SEAT_UNLOCK;
}

/** True when the code says it IS an unlock — a locked panel unlocking through
 *  the sign-in door. A steward is shown the approve card in its unlock form
 *  (PU-A4); anyone else is told they cannot, and nothing is posted (PU-A4n). */
export function isUnlockAsk(ask: SigninAsk): boolean {
  return ask.offer === OFFER_UNLOCK;
}
