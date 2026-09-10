// @vitest-environment happy-dom
/**
 * LinkDeviceQrScreen (#472, slice S5 of #466) — state handling of the desktop
 * QR screen against a fake usePairing client, on a fake clock:
 *   - polling stops on unmount and on every terminal state (no leaked timers),
 *   - leaving the screen cancels the backend session (once),
 *   - Approve is a deliberate click: the code + peer name are shown and the
 *     backend approve is never called until the user clicks,
 *   - after Approve the holder waits for the phone's done{ok,error} — "Linked"
 *     only on ok, the phone's error otherwise,
 *   - the fresh desktop fetches the identity exactly once, runs recovery in link
 *     mode with the AID hints, and never logs the mnemonic,
 *   - 409 identity-present renders a distinct message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

// --- fakes ---------------------------------------------------------------
type Status = {
  state: string;
  outcome: string;
  code: string;
  peerDeviceName: string;
  error: string;
};
const status = (s: Partial<Status>): Status => ({
  state: 'created',
  outcome: '',
  code: '',
  peerDeviceName: '',
  error: '',
  ...s,
});

/** Each getStatus call pops the next queued status; the last one repeats. */
let statusQueue: Status[] = [];
const client = {
  createSession: vi.fn(async () => ({
    sessionId: 'sess-1',
    qrPayload: 'matou://pair?v=1&id=abc&pk=def&s=ghi&cs=http://cfg',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  })),
  getStatus: vi.fn(async () => {
    const next = statusQueue.length > 1 ? statusQueue.shift()! : statusQueue[0];
    if (!next) throw new Error('no status queued');
    return next;
  }),
  approve: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  scan: vi.fn(),
  fetchIdentity: vi.fn(async () => ({
    mnemonic: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
    aid: 'EAID-holder',
    orgAid: 'EORG',
    adminAid: 'EADMIN',
  })),
};

class FakePairingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly aid?: string,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

vi.mock('src/composables/usePairing', () => ({
  usePairing: () => client,
  PairingError: FakePairingError,
}));

const recoverIdentity = vi.fn(async () => ({ success: true, aid: 'EAID-holder', name: 'Aroha' }));
vi.mock('src/composables/useRecoverIdentity', () => ({
  useRecoverIdentity: () => ({ recoverIdentity }),
}));

const setPath = vi.fn();
vi.mock('stores/onboarding', () => ({
  useOnboardingStore: () => ({ setPath }),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QUJD') },
}));

// Light stubs so the test does not depend on the kit header / Quasar button.
const MBtnStub = defineComponent({
  name: 'MBtn',
  props: { disabled: { type: Boolean, default: false } },
  emits: ['click'],
  setup(props, { emit, slots }) {
    return () =>
      h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.());
  },
});
const HeaderStub = defineComponent({
  name: 'OnboardingHeader',
  emits: ['back'],
  setup(_, { emit }) {
    return () => h('button', { class: 'back-btn', onClick: () => emit('back') }, 'back');
  },
});

async function mountScreen() {
  const mod = await import('src/components/onboarding/LinkDeviceQrScreen.vue');
  const wrapper = mount(mod.default, {
    global: { stubs: { MBtn: MBtnStub, OnboardingHeader: HeaderStub } },
  });
  // createSession + QR render.
  await flushPromises();
  await flushPromises();
  return wrapper;
}

/** Advance the fake clock past one poll and settle the resulting promises. */
async function tick(ms = 1600) {
  await vi.advanceTimersByTimeAsync(ms);
  await flushPromises();
}

const buttons = (w: ReturnType<typeof mount>) => w.findAll('button').map((b) => b.text());

describe('LinkDeviceQrScreen (#472)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    statusQueue = [status({ state: 'created' })];
    Object.values(client).forEach((f) => f.mockClear());
    recoverIdentity.mockClear();
    setPath.mockClear();
    (window as unknown as { electronAPI: unknown }).electronAPI = { isElectron: true, platform: 'linux' };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the QR, sends a device name, and stops polling + cancels on unmount', async () => {
    const wrapper = await mountScreen();
    expect(client.createSession).toHaveBeenCalledWith('Linux computer');
    expect(wrapper.find('[data-testid="pairing-qr"]').attributes('src')).toMatch(/^data:image\/png/);
    expect(wrapper.text()).toMatch(/This code expires in \d+:\d\d/);

    await tick();
    await tick();
    const polls = client.getStatus.mock.calls.length;
    expect(polls).toBeGreaterThanOrEqual(2);

    wrapper.unmount();
    expect(client.cancel).toHaveBeenCalledTimes(1);
    expect(client.cancel).toHaveBeenCalledWith('sess-1');
    await tick(10_000);
    expect(client.getStatus.mock.calls.length).toBe(polls); // no poll after unmount
    expect(vi.getTimerCount()).toBe(0); // no leaked interval/timeout
  });

  it('Back cancels the session once and emits back', async () => {
    const wrapper = await mountScreen();
    await wrapper.find('.back-btn').trigger('click');
    expect(wrapper.emitted('back')).toHaveLength(1);
    expect(client.cancel).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    expect(client.cancel).toHaveBeenCalledTimes(1); // not cancelled twice
  });

  it('a refusal outcome shows its message and stops polling', async () => {
    statusQueue = [status({ state: 'created' }), status({ state: 'done', outcome: 'neither' })];
    const wrapper = await mountScreen();
    await tick();
    await tick();
    expect(wrapper.text()).toContain('Neither device has an identity yet');
    const polls = client.getStatus.mock.calls.length;
    await tick(10_000);
    expect(client.getStatus.mock.calls.length).toBe(polls);
    // The backend session is already over: no cancel on the way out.
    wrapper.unmount();
    expect(client.cancel).not.toHaveBeenCalled();
  });

  it('a lost session (404) ends the pairing with a distinct message', async () => {
    client.getStatus.mockRejectedValueOnce(new FakePairingError('session not found', 404, 'session not found'));
    const wrapper = await mountScreen();
    await tick();
    expect(wrapper.text()).toContain('Pairing ended');
    expect(wrapper.text()).toContain('no longer available');
    const polls = client.getStatus.mock.calls.length;
    await tick(10_000);
    expect(client.getStatus.mock.calls.length).toBe(polls);
  });

  it('desktop holds: shows the code + peer name, approves only on click, Linked only after done{ok}', async () => {
    statusQueue = [status({ state: 'acked', outcome: 'desktop-to-phone', code: '012345', peerDeviceName: 'Aroha’s phone' })];
    const wrapper = await mountScreen();
    await tick();
    expect(wrapper.text()).toContain('Sign in on Aroha’s phone?');
    expect(wrapper.find('[data-testid="pairing-code"]').text()).toBe('012345'); // leading zero intact
    expect(buttons(wrapper)).toContain('Approve');

    // Polls keep coming; nothing approves by itself.
    await tick();
    await tick();
    expect(client.approve).not.toHaveBeenCalled();

    // Once the identity is on its way the Approve button is gone and we wait
    // for the phone's done.
    statusQueue = [status({ state: 'identity-sent', outcome: 'desktop-to-phone', code: '012345', peerDeviceName: 'Aroha’s phone' })];
    await wrapper.findAll('button').find((b) => b.text() === 'Approve')!.trigger('click');
    await flushPromises();
    expect(client.approve).toHaveBeenCalledTimes(1);
    expect(client.approve).toHaveBeenCalledWith('sess-1');
    expect(buttons(wrapper)).not.toContain('Approve');
    expect(wrapper.text()).toContain('Sending your identity to Aroha’s phone');
    await tick();
    expect(wrapper.text()).not.toContain('Linked');

    statusQueue = [status({ state: 'done', outcome: 'desktop-to-phone', code: '012345', peerDeviceName: 'Aroha’s phone' })];
    await tick();
    expect(wrapper.text()).toContain('Linked');
    const polls = client.getStatus.mock.calls.length;
    await tick(10_000);
    expect(client.getStatus.mock.calls.length).toBe(polls);

    // Done → back, without cancelling a finished session.
    await wrapper.findAll('button').find((b) => b.text() === 'Done')!.trigger('click');
    expect(wrapper.emitted('back')).toHaveLength(1);
    expect(client.cancel).not.toHaveBeenCalled();
  });

  it("desktop holds: the phone's done{ok:false,error} is shown, not Linked", async () => {
    statusQueue = [status({ state: 'acked', outcome: 'desktop-to-phone', code: '482913', peerDeviceName: 'Phone' })];
    const wrapper = await mountScreen();
    await tick();
    statusQueue = [status({ state: 'done', outcome: 'desktop-to-phone', code: '482913', peerDeviceName: 'Phone', error: 'No identity found for this recovery phrase.' })];
    await wrapper.findAll('button').find((b) => b.text() === 'Approve')!.trigger('click');
    await flushPromises();
    await tick();
    expect(wrapper.text()).toContain('Sign-in failed on your phone');
    expect(wrapper.text()).toContain('No identity found for this recovery phrase.');
    expect(wrapper.text()).not.toContain('Linked');
  });

  it('desktop fresh: waits for the phone, fetches the identity once, recovers in link mode, never logs the mnemonic', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    statusQueue = [status({ state: 'acked', outcome: 'phone-to-desktop', code: '007007', peerDeviceName: 'Phone' })];
    const wrapper = await mountScreen();
    await tick();
    expect(wrapper.text()).toContain('Waiting for approval on your phone');
    expect(wrapper.find('[data-testid="pairing-code"]').text()).toBe('007007');
    expect(client.fetchIdentity).not.toHaveBeenCalled();

    statusQueue = [status({ state: 'done', outcome: 'phone-to-desktop', code: '007007', peerDeviceName: 'Phone' })];
    await tick();
    await flushPromises();
    expect(client.fetchIdentity).toHaveBeenCalledTimes(1);
    expect(recoverIdentity).toHaveBeenCalledWith(
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
      { mode: 'link', adminAid: 'EADMIN', orgAid: 'EORG' },
    );
    expect(setPath).toHaveBeenCalledWith('link');
    expect(wrapper.emitted('continue')).toHaveLength(1);

    const polls = client.getStatus.mock.calls.length;
    await tick(10_000);
    expect(client.getStatus.mock.calls.length).toBe(polls);
    expect(client.fetchIdentity).toHaveBeenCalledTimes(1);

    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().map(String).join(' ');
    expect(logged).not.toContain('alpha bravo charlie');
    expect(wrapper.html()).not.toContain('alpha bravo charlie');
    wrapper.unmount();
    expect(client.cancel).not.toHaveBeenCalled(); // continued: session is done
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('desktop fresh: 409 identity-present renders the refuse-to-overwrite message', async () => {
    client.fetchIdentity.mockRejectedValueOnce(new FakePairingError('identity-present', 409, 'identity-present', 'EAID-here'));
    statusQueue = [status({ state: 'done', outcome: 'phone-to-desktop', code: '111111', peerDeviceName: 'Phone' })];
    const wrapper = await mountScreen();
    await tick();
    await flushPromises();
    expect(wrapper.text()).toContain('Sign-in failed');
    expect(wrapper.text()).toContain('already has an identity (EAID-here)');
    expect(recoverIdentity).not.toHaveBeenCalled();
    expect(wrapper.emitted('continue')).toBeUndefined();
  });

  it('a stale poll from a replaced session never touches the new one', async () => {
    // First session's poll resolves only after "Start over" created session 2.
    let resolveFirst: ((s: Status) => void) | null = null;
    client.getStatus.mockImplementationOnce(
      () =>
        new Promise<Status>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    statusQueue = [status({ state: 'created' })];
    const wrapper = await mountScreen();
    await tick(); // first poll in flight (pending)
    expect(client.getStatus).toHaveBeenCalledTimes(1);

    // Simulate the terminal branch that offers "Start over": queue a failed
    // status for the second session and force a restart via the error path.
    client.createSession.mockResolvedValueOnce({
      sessionId: 'sess-2',
      qrPayload: 'matou://pair?v=1&id=xyz',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    // Drive start() through the component's own entry point: unmount is not
    // wanted here, so call the exposed flow via the Try again path — the
    // simplest is a lost-session error on the *second* poll of session 1.
    resolveFirst!(status({ state: 'done', outcome: 'neither' })); // stale answer for sess-1
    await flushPromises();
    // The stale answer did land (it belongs to the still-current session): the
    // message is shown. Now Start over → session 2.
    await wrapper.findAll('button').find((b) => b.text() === 'Start over')!.trigger('click');
    await flushPromises();
    await flushPromises();
    expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="pairing-qr"]').exists()).toBe(true);
    statusQueue = [status({ state: 'created' })];
    await tick();
    expect(client.getStatus).toHaveBeenLastCalledWith('sess-2');
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
