/**
 * Sign out of the control panel everywhere — the steward's take-back (#665,
 * idss #1935, ADR 0282 d.4, flow panel-unlock W5).
 *
 * One request, SIGNED by the steward's identity over a door-bound message, is
 * posted to the community control plane's take-back door. The control plane
 * advances a per-identity "panel session epoch" and every control-panel session
 * that identity holds — on every computer they unlocked — resolves to no session
 * on its next request. Nothing else is touched: the steward stays a steward,
 * their wallet, credentials and role are untouched, and every OTHER service they
 * are signed in to keeps its session (idss #1935 acceptance 2/5).
 *
 * The wire is idss's snake_case, pinned by idss #1935's merged control plane
 * (internal/controlapi/panelepoch.go @ main):
 *   - door:  <origin(api_url)>/authz/panel/signout-everywhere — the /authz gate
 *            surface the apex allow-list keeps ungated (ADR 0247 d.2). The steward
 *            API (descriptor `api_url`, e.g. https://<apex>/api/v1/idip) is served
 *            at the apex ORIGIN, so its origin IS the apex origin the door binds to
 *            (`doorURL := "https://" + apex + panelSignoutPath` in idss).
 *   - body:  { aid, signed_at, signature } — signed_at is the wallet's own Unix-ms
 *            timestamp AND the replay guard (the control plane refuses an act whose
 *            signed_at does not strictly beat the last accepted one for that AID).
 *   - message signed: idss-panel-signout:<door>:<aid>:<signed_at>
 *   - 204 → signed out; 400 malformed/incomplete, 401 unverified, 409 replayed —
 *            every one an honest refusal that changes NOTHING, so the wallet never
 *            claims sessions ended unless the door answered 204.
 *
 * There is NO session list, device name or count anywhere: the wallet does not
 * know how many computers were unlocked, and inventing a number would be a claim
 * this request cannot support (ADR 0282 d.4, DDR 0246 d.11).
 */

/** The take-back route on the apex, relative to the apex origin (idss panelSignoutPath). */
export const PANEL_SIGNOUT_PATH = '/authz/panel/signout-everywhere';

/**
 * The signed-message prefix (idss panelSignoutMessagePrefix). It binds the bytes
 * to THIS act, so a sign-in signature (`idss-idp:`) can never be replayed as a
 * take-back and vice versa (ADR 0236 §5).
 */
export const SIGNOUT_MESSAGE_PREFIX = 'idss-panel-signout:';

/** The snake_case JSON body the wallet posts (idss panelSignoutRequest). */
export interface PanelSignoutBody {
  aid: string;
  /** The wallet's monotonic Unix-ms timestamp; also the replay guard. */
  signed_at: number;
  /** The qb64 signature over {@link panelSignoutMessage}. */
  signature: string;
}

/** The outcome the row acts on. */
export type PanelSignoutVerdict =
  | { outcome: 'signed-out' }
  | { outcome: 'refused' }
  | { outcome: 'unreachable' };

/**
 * The apex-origin take-back door derived from the descriptor, or `null` when the
 * descriptor carries no address to derive it from (a non-IDSS or not-yet-founded
 * backend). Prefers `api_url` — the steward API served at the apex origin, so its
 * origin IS the apex the door binds to — and falls back to `signin.url`, the IdP
 * on `id.<apex>`, whose apex is the host with the leading `id.` label removed
 * (idss hostnames.IDP). Both resolve to the same apex origin.
 */
export function panelSignoutDoor(opts: { apiUrl?: string; signinUrl?: string }): string | null {
  const origin = apexOrigin(opts.apiUrl) ?? apexFromIdp(opts.signinUrl);
  return origin ? origin + PANEL_SIGNOUT_PATH : null;
}

/** The apex ORIGIN of the steward API URL (its origin is the apex origin). */
function apexOrigin(apiUrl?: string): string | null {
  if (!apiUrl) return null;
  try {
    return new URL(apiUrl).origin;
  } catch {
    return null;
  }
}

/** The apex origin behind the IdP login URL `https://id.<apex>/…` (drop `id.`). */
function apexFromIdp(signinUrl?: string): string | null {
  if (!signinUrl) return null;
  let u: URL;
  try {
    u = new URL(signinUrl);
  } catch {
    return null;
  }
  const labels = u.hostname.split('.');
  const host = labels.length > 2 && labels[0] === 'id' ? labels.slice(1).join('.') : u.hostname;
  return host ? `${u.protocol}//${host}` : null;
}

/**
 * The door-bound message the steward's wallet signs (idss panelSignoutMessage):
 *   idss-panel-signout:<door url>:<aid>:<signed_at>
 * Bound to the door's own address (a signature harvested by a fake door is
 * worthless at the real one) and carrying signed_at (the replay guard).
 */
export function panelSignoutMessage(door: string, aid: string, signedAt: number): string {
  return `${SIGNOUT_MESSAGE_PREFIX}${door}:${aid}:${signedAt}`;
}

/** Everything the take-back needs, resolved by the composable (or faked in tests). */
export interface PanelSignoutInput {
  /** The take-back door URL — signed over AND posted to. */
  door: string;
  /** The steward's signing (holder) AID. */
  aid: string;
  /** The wallet's Unix-ms timestamp / replay guard. */
  signedAt: number;
}

/** The side-effecting dependencies, injected for testability. */
export interface PanelSignoutDeps {
  /** Sign a UTF-8 message, returning the qb64 signature (the cached signer). */
  sign(message: string): Promise<string>;
  /** POST the body to the door and read the verdict. */
  post(door: string, body: PanelSignoutBody): Promise<PanelSignoutVerdict>;
}

/**
 * Run the take-back: sign the door-bound message and post it. Throws only on a
 * genuine wallet-side failure (the signer produced nothing); a door refusal or an
 * unreachable community is a {@link PanelSignoutVerdict}, not an exception.
 */
export async function runPanelSignoutEverywhere(
  input: PanelSignoutInput,
  deps: PanelSignoutDeps,
): Promise<PanelSignoutVerdict> {
  const { door, aid, signedAt } = input;
  const signature = await deps.sign(panelSignoutMessage(door, aid, signedAt));
  return deps.post(door, { aid, signed_at: signedAt, signature });
}

/**
 * POST the take-back to the door and map the answer (idss panelSignoutEverywhere):
 *  - 204 (or any 2xx) → signed out.
 *  - any other status → refused (400 malformed, 401 unverified, 409 replayed) —
 *    the epoch did not move, so nothing claims sessions ended.
 *  - a thrown fetch (no response, DNS, CORS, abort) → unreachable, never a refusal.
 *
 * `fetchImpl` is injectable so tests drive verdicts without a live door.
 */
export async function postPanelSignout(
  door: string,
  body: PanelSignoutBody,
  fetchImpl: typeof fetch = fetch,
): Promise<PanelSignoutVerdict> {
  let res: Response;
  try {
    res = await fetchImpl(door, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // The post never landed. Only the wallet can say the network failed, and it
    // must not claim the take-back happened.
    return { outcome: 'unreachable' };
  }
  if (res.ok) return { outcome: 'signed-out' };
  return { outcome: 'refused' };
}
