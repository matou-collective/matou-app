/**
 * Frontend relay-session minting (#277, refs #177).
 *
 * The Go backend cannot sign the relay's login challenge — the AID signing keys
 * live in signify-ts inside the WebView (docs/signed-auth.md) — so the frontend
 * mints the session it spends: GET /api/v1/push/relay-challenge → sign the
 * domain-separated message `matou-auth:<aid>:<nonce>` with signChallenge → POST
 * /api/v1/push/relay-session. These tests pin, with the API + KERI mocked:
 *  - a session is minted before the first /register of a launch;
 *  - a 401 from /register re-mints (force) and retries the register once;
 *  - app foreground re-mints when the session is within the refresh window of
 *    expiry, and is a cheap no-op while it is still fresh;
 *  - identity switch deregisters the OLD token before the NEW session is minted
 *    (the backend refuses a stale session, c9f0238);
 *  - a mint failure never throws and never blocks the register path;
 *  - the session token is never handled frontend-side (only the expiry is).
 *
 * Same node-env, hand-installed window, real-identity-store shape as
 * push.test.ts (§ its header).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick, ref } from 'vue';
import type { AIDInfo } from 'src/lib/keri/client';

// --- Backend push API: spies -----------------------------------------------
const registerPushToken = vi.fn(
  async (): Promise<{ success: boolean; error?: string; status?: number }> => ({ success: true }),
);
const deregisterPushToken = vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({
  success: true,
}));
const getRelayChallenge = vi.fn(async () => ({
  aid: 'aid-a',
  challenge: 'nonce-1',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
}));
const postRelaySession = vi.fn(async () => ({
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
}));
vi.mock('src/lib/api/push', () => ({
  registerPushToken: (t: string) => registerPushToken(t),
  deregisterPushToken: (t?: string) => deregisterPushToken(t),
  getRelayChallenge: () => getRelayChallenge(),
  postRelaySession: (c: string, s: string) => postRelaySession(c, s),
}));

// --- Chat store: lightweight fake ------------------------------------------
const chatStoreMock = { channels: [] as unknown[], totalUnreadCount: 0 };
vi.mock('stores/chat', () => ({ useChatStore: () => chatStoreMock }));

// --- Identity-store dependencies (real store, mocked deps) -----------------
const setSessionToken = vi.fn();
vi.mock('src/lib/api/client', () => ({
  setSessionToken: (...a: unknown[]) => setSessionToken(...a),
  getUserSpaces: vi.fn(async () => ({})),
  verifyCommunityAccess: vi.fn(async () => ({ hasAccess: false })),
  joinCommunity: vi.fn(async () => ({})),
  getAuthChallenge: vi.fn(async () => ({ challenge: '', expiresAt: '' })),
  postAuthLogin: vi.fn(async () => ({ token: '', expiresAt: '' })),
  authHeaders: () => ({ 'Content-Type': 'application/json' }),
  BACKEND_URL: 'http://127.0.0.1:8080',
}));
const signChallenge = vi.fn(async () => 'B-signature');
vi.mock('src/lib/keri/client', () => ({
  KERIClient: class {},
  useKERIClient: () => ({
    setOrgAID: vi.fn(),
    getSignifyClient: () => null,
    signChallenge: (c: string, a: string) => signChallenge(c, a),
  }),
  initKeriConfig: vi.fn(),
}));
vi.mock('src/lib/secureStorage', () => ({
  secureStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
vi.mock('src/api/config', () => ({
  fetchOrgConfig: vi.fn(),
  getCachedConfig: vi.fn(() => null),
}));

// --- Capacitor plugin fakes (as in push.test.ts) ---------------------------
type Listener = (arg: unknown) => void;
interface FakePush {
  listeners: Record<string, Listener>;
  checkPermissions: ReturnType<typeof vi.fn>;
  requestPermissions: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  emit(event: string, arg: unknown): void;
}
function makePush(initial: string): FakePush {
  const listeners: Record<string, Listener> = {};
  return {
    listeners,
    checkPermissions: vi.fn(async () => ({ receive: initial })),
    requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
    register: vi.fn(async () => undefined),
    addListener: vi.fn((event: string, fn: Listener) => {
      listeners[event] = fn;
    }),
    emit(event: string, arg: unknown) {
      listeners[event]?.(arg);
    },
  };
}
function installCapacitor(push?: FakePush, platform = 'android') {
  const Plugins: Record<string, unknown> = {};
  if (push) Plugins.PushNotifications = push;
  (globalThis as unknown as { window: unknown }).window = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => platform, Plugins },
  };
}

async function loadPush() {
  return import('../../src/composables/usePush');
}
async function settle() {
  for (let i = 0; i < 8; i++) {
    await nextTick();
    await Promise.resolve();
  }
}
function aidInfo(prefix: string): AIDInfo {
  return { prefix } as AIDInfo;
}
async function identityStore() {
  const { useIdentityStore } = await import('../../src/stores/identity');
  return useIdentityStore();
}

/**
 * Drive a granted registration to the point a token has been received, with an
 * active identity so the relay-session mint (which needs an AID) actually runs.
 */
async function registerWithToken(fake: FakePush, token = 'token-a', aid = 'aid-a') {
  const push = await loadPush();
  const identity = await identityStore();
  identity.currentAID = aidInfo(aid);
  await push.requestPermissionAndRegister();
  fake.emit('registration', { value: token });
  await settle();
  return push;
}

describe('relay-session minting (#277)', () => {
  beforeEach(async () => {
    vi.resetModules();
    setActivePinia(createPinia());
    for (const m of [registerPushToken, deregisterPushToken, getRelayChallenge, postRelaySession, signChallenge, setSessionToken]) {
      m.mockClear();
    }
    registerPushToken.mockResolvedValue({ success: true });
    deregisterPushToken.mockResolvedValue({ success: true });
    getRelayChallenge.mockResolvedValue({
      aid: 'aid-a',
      challenge: 'nonce-1',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    postRelaySession.mockResolvedValue({
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    signChallenge.mockResolvedValue('B-signature');
    chatStoreMock.channels = [];
    const push = await loadPush();
    push.__resetPushForTest();
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('mints a relay session before the first backend register', async () => {
    const fake = makePush('granted');
    installCapacitor(fake);
    await registerWithToken(fake, 'token-a');

    // challenge → sign → session → register, in that order.
    expect(getRelayChallenge).toHaveBeenCalledTimes(1);
    expect(signChallenge).toHaveBeenCalledWith('nonce-1', 'aid-a');
    expect(postRelaySession).toHaveBeenCalledWith('nonce-1', 'B-signature');
    expect(registerPushToken).toHaveBeenCalledWith('token-a');
    expect(postRelaySession.mock.invocationCallOrder[0]).toBeLessThan(
      registerPushToken.mock.invocationCallOrder[0],
    );
  });

  it('never handles the relay bearer token frontend-side (only the expiry)', async () => {
    const fake = makePush('granted');
    installCapacitor(fake);
    await registerWithToken(fake, 'token-a');
    // postRelaySession resolves with { expiresAt } only — no token field is read
    // or forwarded anywhere; register is called with the FCM token, never a
    // relay bearer token.
    for (const call of registerPushToken.mock.calls) {
      expect(call[0]).toBe('token-a');
    }
  });

  it('re-mints and retries register once on a 401 from the push API', async () => {
    registerPushToken
      .mockResolvedValueOnce({ success: false, error: 'HTTP 401', status: 401 })
      .mockResolvedValueOnce({ success: true, status: 200 });
    const fake = makePush('granted');
    installCapacitor(fake);
    await registerWithToken(fake, 'token-a');

    // One mint for the initial attempt, a second (forced) after the 401.
    expect(postRelaySession).toHaveBeenCalledTimes(2);
    expect(registerPushToken).toHaveBeenCalledTimes(2);
  });

  it('does not retry register on a non-401 failure', async () => {
    registerPushToken.mockResolvedValue({ success: false, error: 'HTTP 502', status: 502 });
    const fake = makePush('granted');
    installCapacitor(fake);
    await registerWithToken(fake, 'token-a');

    expect(registerPushToken).toHaveBeenCalledTimes(1);
    expect(postRelaySession).toHaveBeenCalledTimes(1);
  });

  it('a mint failure never throws and still attempts register', async () => {
    getRelayChallenge.mockRejectedValue(new Error('relay down'));
    const fake = makePush('granted');
    installCapacitor(fake);
    await registerWithToken(fake, 'token-a');

    // The mint failed but the register path ran anyway (logged, non-blocking).
    expect(postRelaySession).not.toHaveBeenCalled();
    expect(registerPushToken).toHaveBeenCalledWith('token-a');
  });

  describe('foreground refresh', () => {
    it('re-mints when the session is within the refresh window of expiry', async () => {
      // The session held after register expires in 2 min — inside the 5 min
      // refresh skew — so the next foreground must re-mint.
      postRelaySession.mockResolvedValue({
        expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      });
      const fake = makePush('granted');
      installCapacitor(fake);
      const push = await registerWithToken(fake, 'token-a');
      expect(postRelaySession).toHaveBeenCalledTimes(1);

      await push.handleAppForeground(); // near expiry → re-mint
      expect(postRelaySession).toHaveBeenCalledTimes(2);
    });

    it('is a no-op while the session is still fresh', async () => {
      const fake = makePush('granted');
      installCapacitor(fake);
      const push = await registerWithToken(fake, 'token-a');
      const afterRegister = postRelaySession.mock.calls.length;

      await push.handleAppForeground(); // session is 30 min out → nothing to do
      expect(postRelaySession.mock.calls.length).toBe(afterRegister);
    });

    it('is a no-op off the push platform', async () => {
      installCapacitor(undefined, 'web');
      const push = await loadPush();
      await push.handleAppForeground();
      expect(getRelayChallenge).not.toHaveBeenCalled();
    });
  });

  it('deregisters the old token BEFORE minting the new session on identity switch', async () => {
    const fake = makePush('granted');
    installCapacitor(fake);
    const push = await registerWithToken(fake, 'token-a');
    push.ensurePushListeners();

    const identity = await identityStore();
    identity.currentAID = aidInfo('aid-a');
    await settle();

    deregisterPushToken.mockClear();
    postRelaySession.mockClear();
    signChallenge.mockClear();
    getRelayChallenge.mockResolvedValue({
      aid: 'aid-b',
      challenge: 'nonce-b',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });

    // Switch identity: the watcher deregisters aid-a's token, then registers the
    // new AID — whose token, once received, mints a fresh session.
    identity.currentAID = aidInfo('aid-b');
    await settle();
    fake.emit('registration', { value: 'token-b' });
    await settle();

    expect(deregisterPushToken).toHaveBeenCalled();
    expect(postRelaySession).toHaveBeenCalled();
    // The old token's deregister must precede the new AID's session mint, or the
    // relay rejects a deregister spent with the new AID's session.
    expect(deregisterPushToken.mock.invocationCallOrder[0]).toBeLessThan(
      postRelaySession.mock.invocationCallOrder[0],
    );
    // The new session is signed as the new AID.
    expect(signChallenge).toHaveBeenCalledWith('nonce-b', 'aid-b');
  });
});
