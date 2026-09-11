/**
 * usePairing (#472, slice S5 of #466) — the thin frontend client over the
 * backend's /api/v1/pairing/* routes (spec §2, backend slice #471). Runs against
 * a mocked backend (fetch + the api client's BACKEND_URL/authHeaders), asserting
 * the routes/methods and the response shaping, including the 6-char SAS code that
 * may start with 0 and the 409 identity-present refusal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('src/lib/api/client', () => ({
  BACKEND_URL: 'http://127.0.0.1:9080',
  authHeaders: (extra: Record<string, string> = {}) => ({
    'Content-Type': 'application/json',
    'X-User-AID': 'EAID-caller',
    ...extra,
  }),
}));

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string> | undefined;
}
let calls: Call[] = [];

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Install a fetch that dispatches on (method, path) → response body. */
function installFetch(routes: Record<string, (call: Call) => Response>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call: Call = {
      url,
      method,
      body,
      headers: init?.headers as Record<string, string> | undefined,
    };
    calls.push(call);
    const path = new URL(url).pathname;
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected request: ${method} ${path}`);
    return handler(call);
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

async function load() {
  const mod = await import('../../src/composables/usePairing');
  return mod;
}

describe('usePairing (#472)', () => {
  beforeEach(() => {
    vi.resetModules();
    calls = [];
  });

  it('createSession POSTs and returns the QR payload', async () => {
    installFetch({
      'POST /api/v1/pairing/sessions': () =>
        jsonResponse(200, {
          sessionId: 'sess-1',
          qrPayload: 'matou://pair?v=1&id=abc&pk=def&s=ghi&cs=http://cfg',
          expiresAt: '2026-09-10T00:05:00Z',
        }),
    });
    const { usePairing } = await load();
    const result = await usePairing().createSession('My Laptop');

    expect(result.sessionId).toBe('sess-1');
    expect(result.qrPayload).toMatch(/^matou:\/\/pair\?/);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ deviceName: 'My Laptop' });
    expect(calls[0].headers?.['X-User-AID']).toBe('EAID-caller');
  });

  it('getStatus normalises missing fields and keeps the code a string', async () => {
    installFetch({
      'GET /api/v1/pairing/sessions/sess-1': () =>
        jsonResponse(200, {
          state: 'acked',
          outcome: 'phone-to-desktop',
          code: '044175', // leading zero must survive
        }),
    });
    const { usePairing } = await load();
    const status = await usePairing().getStatus('sess-1');

    expect(status).toEqual({
      state: 'acked',
      outcome: 'phone-to-desktop',
      code: '044175',
      peerDeviceName: '',
      error: '',
    });
    expect(typeof status.code).toBe('string');
  });

  it('approve and cancel hit the right subpaths with POST', async () => {
    installFetch({
      'POST /api/v1/pairing/sessions/sess-1/approve': () => jsonResponse(200, { status: 'approved' }),
      'POST /api/v1/pairing/sessions/sess-1/cancel': () => jsonResponse(200, { status: 'cancelled' }),
    });
    const { usePairing } = await load();
    const p = usePairing();
    await p.approve('sess-1');
    await p.cancel('sess-1');

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /api/v1/pairing/sessions/sess-1/approve',
      'POST /api/v1/pairing/sessions/sess-1/cancel',
    ]);
  });

  it('scan POSTs the qrPayload and returns the outcome', async () => {
    installFetch({
      'POST /api/v1/pairing/scan': () =>
        jsonResponse(200, {
          sessionId: 'sess-2',
          outcome: 'desktop-to-phone',
          code: '482913',
          peerDeviceName: 'Aroha’s Laptop',
        }),
    });
    const { usePairing } = await load();
    const result = await usePairing().scan('matou://pair?v=1&id=abc', 'My Phone');

    expect(result.sessionId).toBe('sess-2');
    expect(result.outcome).toBe('desktop-to-phone');
    expect(result.peerDeviceName).toBe('Aroha’s Laptop');
    expect(calls[0].body).toEqual({ qrPayload: 'matou://pair?v=1&id=abc', deviceName: 'My Phone' });
  });

  it('fetchIdentity returns the received identity', async () => {
    installFetch({
      'GET /api/v1/pairing/sessions/sess-1/identity': () =>
        jsonResponse(200, { mnemonic: 'a b c', aid: 'EAID', orgAid: 'EORG', adminAid: 'EADMIN' }),
    });
    const { usePairing } = await load();
    const identity = await usePairing().fetchIdentity('sess-1');
    expect(identity).toEqual({ mnemonic: 'a b c', aid: 'EAID', orgAid: 'EORG', adminAid: 'EADMIN' });
  });

  it('throws a PairingError carrying status + code + aid on 409 identity-present', async () => {
    installFetch({
      'GET /api/v1/pairing/sessions/sess-1/identity': () =>
        jsonResponse(409, { error: 'identity-present', aid: 'EAID-existing' }),
    });
    const { usePairing, PairingError } = await load();
    await expect(usePairing().fetchIdentity('sess-1')).rejects.toMatchObject({
      status: 409,
      code: 'identity-present',
      aid: 'EAID-existing',
    });
    // And it is the typed error, not a bare Error.
    const err = await usePairing().fetchIdentity('sess-1').catch((e) => e);
    expect(err).toBeInstanceOf(PairingError);
  });

  it('throws on config-server-mismatch from scan (400)', async () => {
    installFetch({
      'POST /api/v1/pairing/scan': () =>
        jsonResponse(400, { error: 'config-server-mismatch', message: 'different config server' }),
    });
    const { usePairing } = await load();
    await expect(usePairing().scan('matou://pair?v=1')).rejects.toMatchObject({
      status: 400,
      code: 'config-server-mismatch',
      message: 'different config server',
    });
  });
});
