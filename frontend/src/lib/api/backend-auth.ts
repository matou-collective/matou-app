/**
 * Central backend auth: a fetch wrapper that attaches
 * `Authorization: Bearer <token>` to every request targeting the backend.
 *
 * Two tokens share that header:
 *   - the per-launch API token (issue #16) — proves the caller is this app
 *     (or same-user tooling), required by the backend's TokenGuard on
 *     mutations;
 *   - the signed-challenge session token (issue #18) — proves control of the
 *     user's AID; when present it is preferred, since the backend accepts it
 *     for TokenGuard too and additionally binds the request to a verified
 *     X-User-AID.
 *
 * The auth endpoints themselves (`/api/v1/auth/*`) always get the API token:
 * they are how a session is (re-)obtained, so an expired session must never be
 * sent there. A 401 on a request that used a session token triggers one
 * re-login (via `refreshSession`) and a single retry, so a session that
 * expired or was revoked on key rotation re-mints transparently (see
 * docs/signed-auth.md).
 *
 * Kept free of Pinia/store imports so it can be unit-tested in isolation. The
 * app wires it up via installBackendAuth() in client.ts, passing the live
 * backend URL and token getters.
 */

export interface AuthTarget {
  fetch: typeof fetch;
  __matouAuthInstalled?: boolean;
}

/** Optional signed-auth session hooks for installBackendAuth. */
export interface SessionAuthOptions {
  /** Current, unexpired session token, or null when there is none. */
  getSessionToken?: () => string | null;
  /**
   * Re-run the signed-challenge login and return the new session token (or
   * null if it could not be obtained). Called at most once per 401.
   */
  refreshSession?: () => Promise<string | null>;
}

/** Resolve the URL string from any fetch input form. */
export function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Backend auth endpoints are exempt from session tokens and 401 retries. */
export function isAuthEndpoint(url: string, backendUrl: string): boolean {
  return url.startsWith(`${backendUrl}/api/v1/auth/`);
}

/**
 * Install a fetch wrapper on `target` (usually globalThis) that adds the bearer
 * token to backend-bound requests. Requests to other origins (KERIA, config
 * server) are left untouched, and an explicit Authorization header is preserved
 * (and never retried). Idempotent — installing twice is a no-op.
 *
 * The URL and tokens are read via getters on every call so the wrapper always
 * uses the current values (all are resolved asynchronously at boot / login).
 */
export function installBackendAuth(
  target: AuthTarget,
  getBackendUrl: () => string,
  getToken: () => string,
  session: SessionAuthOptions = {},
): void {
  if (target.__matouAuthInstalled) return;
  const originalFetch = target.fetch.bind(target);

  // Coalesce concurrent re-logins: many requests can 401 at once when a
  // session expires; they all wait on the same refresh.
  let refreshing: Promise<string | null> | null = null;
  const refresh = (): Promise<string | null> => {
    if (!session.refreshSession) return Promise.resolve(null);
    if (!refreshing) {
      refreshing = session.refreshSession().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  };

  target.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveFetchUrl(input);
    const backendUrl = getBackendUrl();
    if (!backendUrl || !url.startsWith(backendUrl)) {
      return originalFetch(input, init);
    }

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (headers.has('Authorization')) {
      return originalFetch(input, init);
    }

    const authPath = isAuthEndpoint(url, backendUrl);
    const sessionToken = authPath ? null : (session.getSessionToken?.() ?? null);
    const token = sessionToken || getToken();
    if (!token) {
      return originalFetch(input, init);
    }
    headers.set('Authorization', `Bearer ${token}`);
    const response = await originalFetch(input, { ...init, headers });

    // Session rejected (expired / revoked on rotation): re-login once and
    // retry. Only string/URL inputs are replayed — a consumed Request body
    // cannot be re-sent.
    if (
      response.status === 401 &&
      sessionToken &&
      session.refreshSession &&
      !(input instanceof Request)
    ) {
      const fresh = await refresh();
      if (fresh && fresh !== sessionToken) {
        const retryHeaders = new Headers(headers);
        retryHeaders.set('Authorization', `Bearer ${fresh}`);
        return originalFetch(input, { ...init, headers: retryHeaders });
      }
    }
    return response;
  };
  target.__matouAuthInstalled = true;
}
