/**
 * setBackendIdentity() retryable-503 contract (issue #469, slice S2).
 *
 * POST /api/v1/identity/set with mode:"link" (and, transiently, other modes)
 * can 503 while the private/community/read-only/admin space isn't reachable
 * yet, with body `{"error":"private space not reachable","retryable":true}`.
 * That's a "data still syncing" condition, not a hard failure — callers
 * (WelcomeOverlayScreen.vue) branch on `result.retryable` to show a
 * "Waiting for your data to sync…" state with a Retry instead of failing the
 * check outright. This pins that the client surfaces `retryable` + the HTTP
 * `status` from the JSON body / response, defaulting retryable to false when
 * the body omits it (older backend, or a different error).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('setBackendIdentity retryable 503 (#469)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('surfaces retryable + status from a 503 "private space not reachable" body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(503, { error: 'private space not reachable', retryable: true })),
    );

    const { setBackendIdentity } = await import('../../src/lib/api/client');
    const result = await setBackendIdentity({ aid: 'EAID-a', mnemonic: 'word '.repeat(24).trim(), mode: 'link' });

    expect(result).toEqual({
      error: 'private space not reachable',
      retryable: true,
      status: 503,
    });
  });

  it('defaults retryable to false when the body omits it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })));

    const { setBackendIdentity } = await import('../../src/lib/api/client');
    const result = await setBackendIdentity({ aid: 'EAID-a', mnemonic: 'm' });

    expect(result.retryable).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe('boom');
  });

  it('still returns the plain network-error shape when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const { setBackendIdentity } = await import('../../src/lib/api/client');
    const result = await setBackendIdentity({ aid: 'EAID-a', mnemonic: 'm' });

    expect(result).toEqual({ success: false, error: 'Network error' });
  });

  it('reports success:true with retryable:false on a normal 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, peerId: 'peer-1', privateSpaceId: 'space-1' })),
    );

    const { setBackendIdentity } = await import('../../src/lib/api/client');
    const result = await setBackendIdentity({ aid: 'EAID-a', mnemonic: 'm' });

    expect(result).toEqual({
      success: true,
      peerId: 'peer-1',
      privateSpaceId: 'space-1',
      status: 200,
      retryable: false,
    });
  });
});
