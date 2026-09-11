// @vitest-environment happy-dom
/**
 * "Sign out of this device" (#474, slice S7 of #466) must clear the **backend**
 * identity, not only the frontend stores.
 *
 * The backend keeps the identity — recovery phrase included — in
 * {dataDir}/identity.json, and while one is configured it refuses every
 * *different* identity: pairing answers 409 identity-present / outcome
 * `conflict`, and POST /api/v1/identity/set is denied to anyone who is not the
 * stored owner. So a frontend-only disconnect() leaves the phrase on disk and
 * makes the sign-out dialog's own promise — "To use a different identity on
 * this device, sign out first" — impossible to keep.
 *
 * These tests pin the two halves of the fix:
 *   1. clearBackendIdentity() sends an authenticated DELETE /api/v1/identity,
 *      and reports (never swallows) a refusal;
 *   2. AccountSettingsPage's confirmSignOut() calls it *before*
 *      identityStore.disconnect() — after disconnect the AID and session token
 *      are gone, so the DELETE would be rejected — and aborts the sign-out
 *      (no local wipe, no reload) when the backend refuses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('src/stores/identity', () => ({
  useIdentityStore: () => ({ aidPrefix: 'EOWNER' }),
}));
vi.mock('../../src/stores/identity', () => ({
  useIdentityStore: () => ({ aidPrefix: 'EOWNER' }),
}));

let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let respond: () => Response;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  respond = () => new Response(JSON.stringify({ status: 'identity cleared' }), { status: 200 });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.resetModules();
});

describe('clearBackendIdentity', () => {
  it('DELETEs /api/v1/identity as the identity owner', async () => {
    const { clearBackendIdentity } = await import('../../src/lib/api/client');

    const result = await clearBackendIdentity('EOWNER');

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/api\/v1\/identity$/);
    expect(calls[0]!.init?.method).toBe('DELETE');
    // RBAC: once an identity exists only its owner (or an admin) may clear it.
    expect(new Headers(calls[0]!.init?.headers).get('X-User-AID')).toBe('EOWNER');
  });

  it('reports a refusal instead of pretending the identity was cleared', async () => {
    const { clearBackendIdentity } = await import('../../src/lib/api/client');
    respond = () =>
      new Response(JSON.stringify({ error: 'insufficient permissions' }), { status: 403 });

    const result = await clearBackendIdentity('ESOMEONE-ELSE');

    expect(result.success).toBe(false);
    expect(result.error).toBe('insufficient permissions');
  });

  it('reports a network failure rather than throwing', async () => {
    const { clearBackendIdentity } = await import('../../src/lib/api/client');
    globalThis.fetch = vi.fn(async () => {
      throw new Error('backend down');
    }) as unknown as typeof fetch;

    const result = await clearBackendIdentity('EOWNER');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });
});

describe('AccountSettingsPage sign-out wiring', () => {
  // The page is a ~2000-line component wired to a dozen stores, so the
  // ordering contract is pinned on its source: the two calls must appear in
  // this order, and the backend clear must gate the local wipe. A behavioural
  // mount test would need the whole dashboard shell for no extra signal.
  const src = readFileSync(
    join(__dirname, '../../src/pages/AccountSettingsPage.vue'),
    'utf8',
  );
  // Comments discuss the very calls being ordered, so strip them first.
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const body = code.slice(code.indexOf('async function confirmSignOut'));
  const confirmSignOut = body.slice(0, body.indexOf('\n}\n') + 2);

  it('clears the backend identity before disconnecting the frontend', () => {
    const clear = confirmSignOut.indexOf('clearBackendIdentity(');
    const disconnect = confirmSignOut.indexOf('identityStore.disconnect()');
    expect(clear, 'confirmSignOut must call clearBackendIdentity').toBeGreaterThan(-1);
    expect(disconnect, 'confirmSignOut must call identityStore.disconnect').toBeGreaterThan(-1);
    expect(
      clear,
      'the DELETE must go out while the AID and session token are still valid',
    ).toBeLessThan(disconnect);
  });

  it('aborts the sign-out when the backend refuses, leaving nothing wiped', () => {
    // The early `return` on !cleared.success must come before disconnect() and
    // before the reload, so a failed clear leaves the device fully signed in.
    const guard = confirmSignOut.indexOf('cleared.success');
    const disconnect = confirmSignOut.indexOf('identityStore.disconnect()');
    const reload = confirmSignOut.indexOf('window.location.reload()');
    expect(guard, 'confirmSignOut must check the clear result').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(disconnect);
    expect(guard).toBeLessThan(reload);
    expect(confirmSignOut.slice(guard, disconnect)).toMatch(/\breturn;/);
  });

  it('surfaces the failure to the user instead of failing silently', () => {
    expect(confirmSignOut).toMatch(/signOutError\.value\s*=/);
    expect(src).toContain('data-test="signout-error"');
  });
});
