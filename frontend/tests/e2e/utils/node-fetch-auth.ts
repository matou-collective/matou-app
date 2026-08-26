/**
 * Node global-fetch authentication for the e2e test process.
 *
 * The backend's TokenGuard (issue #16) rejects mutating requests that lack an
 * `Authorization: Bearer <token>` header. Playwright's `extraHTTPHeaders`
 * covers browser requests and the `request` (APIRequestContext) fixture, but
 * NOT calls made through Node's global `fetch` — which several specs use
 * directly for seeding and identity setup (e.g. e2e-multi-backend's
 * `/api/v1/identity/set`, feature specs' API seeding).
 *
 * This module wraps `globalThis.fetch` once so any request to a local matou
 * backend `/api/` route gets the fixed dev token when the caller didn't set
 * an Authorization header. It is imported for its side effect at the top of
 * playwright.config.ts, which Playwright evaluates in every worker process, so
 * the patch applies to all specs without per-call changes. Requests that
 * already carry an Authorization header (e.g. deliberate negative tests) are
 * left untouched.
 */

// Mirrors backend DevAPIToken / frontend DEV_API_TOKEN — the fixed fallback
// token dev/test backends accept.
const DEV_API_TOKEN = 'matou-dev';

interface Patchable {
  fetch: typeof fetch;
  __matouNodeFetchAuth?: boolean;
}

function isLocalBackendApi(url: string): boolean {
  try {
    const u = new URL(url);
    const localHost = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return localHost && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

export function installNodeFetchAuth(target: Patchable = globalThis as unknown as Patchable): void {
  if (target.__matouNodeFetchAuth) return;
  const originalFetch = target.fetch.bind(target);

  target.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (isLocalBackendApi(url)) {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${DEV_API_TOKEN}`);
        return originalFetch(input, { ...init, headers });
      }
    }

    return originalFetch(input, init);
  };
  target.__matouNodeFetchAuth = true;
}

// Apply on import so worker processes that load playwright.config.ts get it.
installNodeFetchAuth();
