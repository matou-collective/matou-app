/**
 * Unit tests for the central backend auth fetch wrapper (issue #16).
 * Verifies the per-launch API token is attached to backend-bound mutating
 * requests, that other origins are left untouched, and that an explicit
 * Authorization header is preserved.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  installBackendAuth,
  isAuthEndpoint,
  resolveFetchUrl,
  type AuthTarget,
} from '../../src/lib/api/backend-auth';

const BACKEND = 'http://127.0.0.1:8080';
const TOKEN = 'test-token-123';

function makeTarget(): { target: AuthTarget; calls: Array<[RequestInfo | URL, RequestInit | undefined]> } {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const target: AuthTarget = {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  };
  return { target, calls };
}

function authHeaderOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('Authorization');
}

describe('resolveFetchUrl', () => {
  it('handles string, URL, and Request inputs', () => {
    expect(resolveFetchUrl('http://x/y')).toBe('http://x/y');
    expect(resolveFetchUrl(new URL('http://x/y'))).toBe('http://x/y');
    expect(resolveFetchUrl(new Request('http://x/y'))).toBe('http://x/y');
  });
});

describe('installBackendAuth', () => {
  it('adds the bearer token to backend-bound requests', async () => {
    const { target, calls } = makeTarget();
    installBackendAuth(target, () => BACKEND, () => TOKEN);

    await target.fetch(`${BACKEND}/api/v1/members/EABC/role`, { method: 'PUT' });

    expect(authHeaderOf(calls[0]![1])).toBe(`Bearer ${TOKEN}`);
  });

  it('leaves requests to other origins untouched', async () => {
    const { target, calls } = makeTarget();
    installBackendAuth(target, () => BACKEND, () => TOKEN);

    await target.fetch('http://keria.example:3901/oobi', { method: 'POST' });

    expect(authHeaderOf(calls[0]![1])).toBeNull();
  });

  it('preserves an explicit Authorization header', async () => {
    const { target, calls } = makeTarget();
    installBackendAuth(target, () => BACKEND, () => TOKEN);

    await target.fetch(`${BACKEND}/api/v1/x`, {
      method: 'POST',
      headers: { Authorization: 'Bearer explicit' },
    });

    expect(authHeaderOf(calls[0]![1])).toBe('Bearer explicit');
  });

  it('does not attach a header when no token is configured', async () => {
    const { target, calls } = makeTarget();
    installBackendAuth(target, () => BACKEND, () => '');

    await target.fetch(`${BACKEND}/api/v1/x`, { method: 'POST' });

    expect(authHeaderOf(calls[0]![1])).toBeNull();
  });

  it('reads the token lazily so late-resolved tokens are used', async () => {
    const { target, calls } = makeTarget();
    let token = '';
    installBackendAuth(target, () => BACKEND, () => token);

    token = 'resolved-later';
    await target.fetch(`${BACKEND}/api/v1/x`, { method: 'POST' });

    expect(authHeaderOf(calls[0]![1])).toBe('Bearer resolved-later');
  });

  it('is idempotent — installing twice does not double-wrap', async () => {
    const { target, calls } = makeTarget();
    installBackendAuth(target, () => BACKEND, () => TOKEN);
    const wrappedOnce = target.fetch;
    installBackendAuth(target, () => BACKEND, () => 'other');
    expect(target.fetch).toBe(wrappedOnce);

    await target.fetch(`${BACKEND}/api/v1/x`, { method: 'POST' });
    expect(authHeaderOf(calls[0]![1])).toBe(`Bearer ${TOKEN}`);
  });

  it('preserves the GET method and adds the header (backend leaves GET open, but header is harmless)', async () => {
    const { target, calls } = makeTarget();
    installBackendAuth(target, () => BACKEND, () => TOKEN);

    await target.fetch(`${BACKEND}/api/v1/projects`);

    expect(authHeaderOf(calls[0]![1])).toBe(`Bearer ${TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// Signed-auth session token handling (issue #18)
// ---------------------------------------------------------------------------

function makeStatusTarget(statuses: number[]): {
  target: AuthTarget;
  calls: Array<[RequestInfo | URL, RequestInit | undefined]>;
} {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const target: AuthTarget = {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 200;
      return new Response('{}', { status });
    }) as unknown as typeof fetch,
  };
  return { target, calls };
}

describe('installBackendAuth — session tokens', () => {
  it('prefers a live session token over the API token', async () => {
    const { target, calls } = makeTarget();
    installBackendAuth(target, () => BACKEND, () => TOKEN, { getSessionToken: () => 'sess-1' });

    await target.fetch(`${BACKEND}/api/v1/projects`, { method: 'POST' });

    expect(authHeaderOf(calls[0]![1])).toBe('Bearer sess-1');
  });

  it('falls back to the API token when there is no session', async () => {
    const { target, calls } = makeTarget();
    installBackendAuth(target, () => BACKEND, () => TOKEN, { getSessionToken: () => null });

    await target.fetch(`${BACKEND}/api/v1/projects`, { method: 'POST' });

    expect(authHeaderOf(calls[0]![1])).toBe(`Bearer ${TOKEN}`);
  });

  it('always uses the API token for the auth endpoints (never a stale session)', async () => {
    const { target, calls } = makeTarget();
    installBackendAuth(target, () => BACKEND, () => TOKEN, { getSessionToken: () => 'sess-1' });

    await target.fetch(`${BACKEND}/api/v1/auth/challenge`, { method: 'POST' });
    await target.fetch(`${BACKEND}/api/v1/auth/login`, { method: 'POST' });

    expect(authHeaderOf(calls[0]![1])).toBe(`Bearer ${TOKEN}`);
    expect(authHeaderOf(calls[1]![1])).toBe(`Bearer ${TOKEN}`);
    expect(isAuthEndpoint(`${BACKEND}/api/v1/auth/login`, BACKEND)).toBe(true);
    expect(isAuthEndpoint(`${BACKEND}/api/v1/authors`, BACKEND)).toBe(false);
  });

  it('re-logs in once and retries when a session-authenticated request gets 401', async () => {
    const { target, calls } = makeStatusTarget([401, 200]);
    let session = 'sess-old';
    const refreshSession = vi.fn(async () => {
      session = 'sess-new';
      return session;
    });
    installBackendAuth(target, () => BACKEND, () => TOKEN, {
      getSessionToken: () => session,
      refreshSession,
    });

    const res = await target.fetch(`${BACKEND}/api/v1/projects`, {
      method: 'POST',
      body: '{"a":1}',
    });

    expect(res.status).toBe(200);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(authHeaderOf(calls[0]![1])).toBe('Bearer sess-old');
    expect(authHeaderOf(calls[1]![1])).toBe('Bearer sess-new');
    expect(calls[1]![1]?.body).toBe('{"a":1}');
  });

  it('returns the 401 when re-login fails, without looping', async () => {
    const { target, calls } = makeStatusTarget([401, 401]);
    const refreshSession = vi.fn(async () => null);
    installBackendAuth(target, () => BACKEND, () => TOKEN, {
      getSessionToken: () => 'sess-old',
      refreshSession,
    });

    const res = await target.fetch(`${BACKEND}/api/v1/projects`, { method: 'POST' });

    expect(res.status).toBe(401);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a 401 that was answered to the API token (no session involved)', async () => {
    const { target, calls } = makeStatusTarget([401]);
    const refreshSession = vi.fn(async () => 'sess-new');
    installBackendAuth(target, () => BACKEND, () => TOKEN, {
      getSessionToken: () => null,
      refreshSession,
    });

    const res = await target.fetch(`${BACKEND}/api/v1/projects`, { method: 'POST' });

    expect(res.status).toBe(401);
    expect(refreshSession).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('coalesces concurrent re-logins into one refresh', async () => {
    const { target } = makeStatusTarget([401, 401, 200, 200]);
    let resolveRefresh: (t: string) => void = () => {};
    const refreshSession = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    installBackendAuth(target, () => BACKEND, () => TOKEN, {
      getSessionToken: () => 'sess-old',
      refreshSession,
    });

    const p1 = target.fetch(`${BACKEND}/api/v1/a`, { method: 'POST' });
    const p2 = target.fetch(`${BACKEND}/api/v1/b`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 0));
    resolveRefresh('sess-new');
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
