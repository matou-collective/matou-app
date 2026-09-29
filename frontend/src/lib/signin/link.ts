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
 *   matou://signin?door=<site url>&c=<challenge>&present=<present url>&s=<schema SAID(s)>&name=<community>&svc=<service>
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
 *  - `ek`      the control-panel tab's throwaway **Ed25519 sealing-key verkey**
 *              (qb64). It rides ONLY a control-panel challenge whose code offered
 *              a sealing key (app-door-golden `panel`), so its mere presence is
 *              the machine-readable signal that this is a control-panel sign-in
 *              expecting a passcode handover (#663; never string-match `svc`,
 *              which is a display name). An ordinary service sign-in carries the
 *              other six params and no `ek`. A public key by design — it travels
 *              in the URL; the passcode never does.
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
 * `isSigninLink` is the cheap discriminator the scan/paste paths use.
 */

/** The `matou://signin?…` scheme + host the wallet answers. */
const SIGNIN_PREFIX = 'matou://signin?';

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
   * The control-panel tab's sealing-key verkey (qb64) from `ek=`, present ONLY
   * on a control-panel sign-in that offered a passcode handover. Its presence —
   * not the display-name `service` — is the signal that a steward may unlock the
   * seat on this computer (#663). Absent (undefined) on every ordinary sign-in.
   */
  sealingKey?: string;
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

  // `ek` rides only a control-panel challenge that offered a sealing key; carry
  // it only when present so an ordinary sign-in's ask is byte-identical to what
  // it was before #663 (the panel path keys off `sealingKey` being set).
  const sealingKey = get('ek').trim();
  if (sealingKey) ask.sealingKey = sealingKey;

  // `cred` names the credential the door asks for (#683). Carried only when
  // present, so an ask with no `cred` is exactly the ask it was.
  const credential = get('cred').trim();
  if (credential) ask.credential = credential;

  return ask;
}

/** True when the ask is a control-panel sign-in that offered a passcode handover
 *  (it carried `ek=`). The steward-unlock line appears only for these (#663). */
export function isPanelSignin(ask: SigninAsk): boolean {
  return !!ask.sealingKey;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The control-panel UNLOCK code (idss #1929 story 13–16, ADR 0282 d.3, wireframe
 * PU-M0q/PU-A4; matou-app #664).
 *
 * A panel that is signed in but LOCKED (a reload, a tab close, an explicit Lock,
 * or the unlock line switched off at sign-in) shows an *unlock code*, not a
 * sign-in code. It is a DIFFERENT scheme, `matou://unlock?…`, because scanning it
 * unlocks the seat and nothing else — no session is minted, no credential is
 * presented, and a reload must never look like being signed out (PU-A4). The
 * panel mints a FRESH sealing keypair for every unlock (the old one died with the
 * page), so the key carried here differs from the one at sign-in by construction.
 *
 * The code carries (PU-M0q's QR + the #664 wire ruling on this ticket):
 *
 *   matou://unlock?panel=<url>&present=<relay>&u=<challenge>&ek=<key>&name=<community>&t=<time>&exp=<expiry>
 *
 *  - `panel`    the panel site's address (`admin.<apex>`), for the WHERE line.
 *  - `present`  the bridge relay URL the sealed box is POSTed to, verbatim —
 *              never derived from `panel` (the #574 principle the sign-in link
 *              already holds). A code with no `present` cannot be answered, so it
 *              is refused rather than guessed at.
 *  - `u`        the unlock challenge id (the nonce the sealed box is bound to).
 *  - `ek`       the tab's FRESH Ed25519 sealing verkey (qb64). A public key by
 *              design — it rides the URL; the passcode never does. Without it
 *              there is nothing to seal to, so the code is refused.
 *  - `name`     the community name, for "‹community›'s control panel".
 *  - `t`        the time the steward signed in on this computer, for the
 *              "You signed in on this computer at ‹time›" line. Tolerated absent.
 *  - `exp`      the challenge's expiry as unix epoch seconds. When present and
 *              already past, the card refuses cleanly at read time rather than
 *              sealing to a dead challenge (the door's 410 is handled too).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The `matou://unlock?…` scheme + host the wallet answers for a panel unlock. */
const UNLOCK_PREFIX = 'matou://unlock?';

/** One parsed unlock ask — everything the unlock-only card (PU-A4) needs. */
export interface UnlockAsk {
  /** The panel site's address, for the WHERE line (`admin.<apex>`). */
  panel: string;
  /** The exact relay URL the sealed box is POSTed to (verbatim, never derived). */
  present: string;
  /** The unlock challenge id / nonce the sealed box is bound to. */
  challenge: string;
  /** The tab's FRESH sealing-key verkey (qb64) the passcode is sealed to. */
  sealingKey: string;
  /** The community name for "‹community›'s control panel" (may be empty). */
  community: string;
  /** The time the steward signed in on this computer (empty when absent). */
  signedInAt: string;
  /** The challenge expiry as unix epoch **milliseconds**, or null when the code
   *  carried no `exp`. Parsed from `exp` (unix seconds) so the card can refuse a
   *  dead challenge at read time. */
  expiresAt: number | null;
}

/**
 * Cheap client-side shape check before the wallet acts on an unlock code: a
 * `matou://unlock` link must at least carry a `panel`, a challenge `u` and the
 * sealing key `ek`. A random string gets a plain "not an unlock code" rather
 * than a half-built card. Mirrors {@link isSigninLink}.
 */
export function isUnlockLink(text: string): boolean {
  if (!text.startsWith(UNLOCK_PREFIX)) return false;
  const params = new URLSearchParams(text.slice(UNLOCK_PREFIX.length));
  return !!(params.get('panel') && params.get('u') && params.get('ek'));
}

/**
 * Parse a `matou://unlock?…` link into an {@link UnlockAsk}, or `null` when the
 * text is not a well-formed unlock link (wrong scheme, or missing the panel,
 * challenge, sealing key or `present` URL). Like the sign-in link, a code with no
 * `present` is refused rather than answered by guessing a path (#574). Never
 * throws on member input.
 */
export function parseUnlockLink(text: string): UnlockAsk | null {
  if (!isUnlockLink(text)) return null;
  const params = new URLSearchParams(text.slice(UNLOCK_PREFIX.length));

  const panel = (params.get('panel') ?? '').trim();
  const challenge = (params.get('u') ?? '').trim();
  const sealingKey = (params.get('ek') ?? '').trim();
  const present = (params.get('present') ?? '').trim();
  if (!panel || !challenge || !sealingKey || !present) return null;

  const community = (params.get('name') ?? '').trim();
  const signedInAt = (params.get('t') ?? '').trim();

  // `exp` is unix seconds (JWT convention); carry it as millis for a direct
  // compare with Date.now(), and drop a blank or non-numeric value to null so a
  // malformed exp never reads as "already expired".
  const expRaw = Number.parseInt((params.get('exp') ?? '').trim(), 10);
  const expiresAt = Number.isFinite(expRaw) && expRaw > 0 ? expRaw * 1000 : null;

  return { panel, present, challenge, sealingKey, community, signedInAt, expiresAt };
}
