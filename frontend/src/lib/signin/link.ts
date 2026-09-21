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

  const door = (params.get('door') ?? '').trim();
  const challenge = (params.get('c') ?? '').trim();
  const present = (params.get('present') ?? '').trim();
  if (!door || !challenge || !present) return null;

  // `s` is one SAID today but may be comma-separated for a multi-schema ask;
  // split, trim and drop blanks so an empty `s` yields no schema rather than [''].
  const schemas = (params.get('s') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const community = (params.get('name') ?? '').trim();
  const service = (params.get('service') ?? params.get('svc') ?? '').trim();

  return { door, present, challenge, schemas, community, service };
}
