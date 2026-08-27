/**
 * Signed-auth session helper for e2e specs (issue #18).
 *
 * With MATOU_REQUIRE_SIGNED_AUTH on (backend-manager.ts sets it for every
 * e2e backend), a bare `X-User-AID` header is stripped: the backend only
 * trusts an AID that arrives with a Bearer session token minted through the
 * signed-challenge login. The app does that login itself on connect, so the
 * cheapest way for a spec to obtain a session is to read it out of the
 * already-logged-in page's identity store — no signify-ts in Node, no second
 * KERIA connection.
 *
 * Usage:
 *   const admin = await loginAs(adminPage);          // { aid, token }
 *   await request.post(url, { headers: sessionHeaders(admin.aid) });
 *   await fetch(url, { headers: sessionHeaders(admin.aid, { 'Content-Type': 'application/json' }) });
 *
 * sessionHeaders() looks the token up by AID from the registry loginAs()
 * fills, so existing call sites that only know the AID keep working with a
 * one-line change. Tokens are per backend process: a memberPage routed to a
 * member backend yields a token for THAT backend (its AID differs from the
 * admin's, so keying by AID is unambiguous).
 */
import type { Page } from '@playwright/test';

export interface SessionAuth {
  aid: string;
  token: string;
}

const sessions = new Map<string, string>(); // aid -> session token

/** Register a session token for an AID (for tokens obtained out of band). */
export function registerSession(aid: string, token: string): void {
  sessions.set(aid, token);
}

/** Forget all registered sessions (e.g. after a backend restart). */
export function clearSessions(): void {
  sessions.clear();
}

/**
 * Headers for a request acting as `aid`: the Bearer session token (when one
 * is registered) plus X-User-AID, which the backend overwrites with the
 * session's verified AID but which keeps working with enforcement off.
 */
export function sessionHeaders(
  aid: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { ...extra, 'X-User-AID': aid };
  const token = sessions.get(aid);
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/** JSON convenience: sessionHeaders() with Content-Type set. */
export function jsonSessionHeaders(aid: string): Record<string, string> {
  return sessionHeaders(aid, { 'Content-Type': 'application/json' });
}

interface StoreSnapshot {
  aid: string | null;
  token: string | null;
}

/**
 * Read the identity store's live session from a logged-in page. Reaches the
 * Pinia instance through the mounted Vue app (`#q-app.__vue_app__`), which
 * Vue sets on the root container in every build.
 */
async function readSession(page: Page, retryLogin: boolean): Promise<StoreSnapshot> {
  return page.evaluate(async (retry) => {
    type IdentityStore = {
      aidPrefix: string | null;
      backendSessionToken: string | null;
      signInToBackend: () => Promise<boolean>;
    };
    const root = document.querySelector('#q-app') as
      | (Element & { __vue_app__?: { config: { globalProperties: { $pinia?: { _s: Map<string, unknown> } } } } })
      | null;
    const pinia = root?.__vue_app__?.config.globalProperties.$pinia;
    const store = pinia?._s.get('identity') as IdentityStore | undefined;
    if (!store) return { aid: null, token: null };
    if (!store.backendSessionToken && retry) {
      await store.signInToBackend();
    }
    return { aid: store.aidPrefix, token: store.backendSessionToken };
  }, retryLogin);
}

/**
 * Obtain (and register) the signed-auth session of the identity logged in on
 * `page`. If the app has not minted one yet (e.g. sign-in raced the page
 * load), it asks the store to sign in once more. Throws when no session can
 * be obtained — with enforcement on, continuing would only produce 401s.
 */
export async function loginAs(page: Page): Promise<SessionAuth> {
  let snap = await readSession(page, false);
  if (!snap.token) snap = await readSession(page, true);
  if (!snap.aid) {
    throw new Error('loginAs: page has no current AID — is the identity logged in?');
  }
  if (!snap.token) {
    throw new Error(
      `loginAs: no backend session for ${snap.aid} — signed-challenge login failed ` +
        '(check the backend log for "[Auth] login failed")',
    );
  }
  registerSession(snap.aid, snap.token);
  return { aid: snap.aid, token: snap.token };
}
