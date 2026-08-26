/**
 * Central backend auth: a fetch wrapper that attaches
 * `Authorization: Bearer <token>` to every request targeting the backend.
 *
 * Kept free of Pinia/store imports so it can be unit-tested in isolation. The
 * app wires it up via installBackendAuth() in client.ts, passing the live
 * backend URL and token getters.
 */

export interface AuthTarget {
  fetch: typeof fetch;
  __matouAuthInstalled?: boolean;
}

/** Resolve the URL string from any fetch input form. */
export function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Install a fetch wrapper on `target` (usually globalThis) that adds the bearer
 * token to backend-bound requests. Requests to other origins (KERIA, config
 * server) are left untouched, and an explicit Authorization header is preserved.
 * Idempotent — installing twice is a no-op.
 *
 * The URL and token are read via getters on every call so the wrapper always
 * uses the current values (both are resolved asynchronously at boot).
 */
export function installBackendAuth(
  target: AuthTarget,
  getBackendUrl: () => string,
  getToken: () => string,
): void {
  if (target.__matouAuthInstalled) return;
  const originalFetch = target.fetch.bind(target);

  target.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveFetchUrl(input);
    const token = getToken();
    const backendUrl = getBackendUrl();

    if (token && backendUrl && url.startsWith(backendUrl)) {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return originalFetch(input, { ...init, headers });
    }

    return originalFetch(input, init);
  };
  target.__matouAuthInstalled = true;
}
