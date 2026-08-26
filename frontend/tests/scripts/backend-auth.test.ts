/**
 * Unit tests for the central backend auth fetch wrapper (issue #16).
 * Verifies the per-launch API token is attached to backend-bound mutating
 * requests, that other origins are left untouched, and that an explicit
 * Authorization header is preserved.
 */
import { describe, it, expect, vi } from 'vitest';
import { installBackendAuth, resolveFetchUrl, type AuthTarget } from '../../src/lib/api/backend-auth';

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
