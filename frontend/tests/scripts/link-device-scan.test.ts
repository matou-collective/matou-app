// @vitest-environment happy-dom
/**
 * LinkDeviceScanScreen outcome rendering (#473, mobile linked-device sign-in).
 *
 * Mounts the screen with usePairing / useRecoverIdentity / the barcode lib
 * mocked, drives the paste fallback (what emulators, e2e and dev use), and
 * asserts each §1 outcome renders the right chrome:
 *   - desktop-to-phone → SAS code + "Waiting for approval…"
 *   - phone-to-desktop → SAS code + peer name + Approve/Cancel
 *   - neither / already-linked / conflict → the blocking message
 * plus the SAS-code-is-a-string invariant (a leading zero must survive).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent } from 'vue';

// --- mocks (hoisted so the vi.mock factories can see them) ------------------
const h = vi.hoisted(() => {
  // Mirrors src/composables/usePairing PairingError(message, status, code?, aid?).
  class PairingError extends Error {
    constructor(
      message: string,
      public status: number,
      public code?: string,
      public aid?: string,
    ) {
      super(message);
    }
  }
  return {
    PairingError,
    scan: vi.fn(),
    getStatus: vi.fn(),
    approve: vi.fn(),
    cancel: vi.fn(),
    fetchIdentity: vi.fn(),
    recoverIdentity: vi.fn(),
    scanPairingQr: vi.fn(),
    isScannerAvailable: vi.fn(() => true),
    getCapacitorPlatform: vi.fn(() => 'android'),
  };
});

vi.mock('src/composables/usePairing', () => ({
  usePairing: () => ({
    createSession: vi.fn(),
    scan: h.scan,
    getStatus: h.getStatus,
    approve: h.approve,
    cancel: h.cancel,
    fetchIdentity: h.fetchIdentity,
  }),
  PairingError: h.PairingError,
}));

vi.mock('src/composables/useRecoverIdentity', () => ({
  useRecoverIdentity: () => ({ recoverIdentity: h.recoverIdentity }),
}));

vi.mock('src/lib/barcode', () => ({
  isScannerAvailable: h.isScannerAvailable,
  scanPairingQr: h.scanPairingQr,
  ScanUnavailableError: class ScanUnavailableError extends Error {
    constructor(
      message: string,
      public reason: string,
    ) {
      super(message);
    }
  },
}));

vi.mock('src/lib/capacitor', () => ({
  getCapacitorPlatform: h.getCapacitorPlatform,
}));

import LinkDeviceScanScreen from 'src/components/onboarding/LinkDeviceScanScreen.vue';

// Lightweight stand-ins for the Quasar-backed base components, so class/type
// fall-through lands on real DOM elements (mirrors kit-setup.test.ts).
const MBtnStub = defineComponent({
  props: { disabled: { type: Boolean, default: false } },
  template: `<button :disabled="disabled"><slot /></button>`,
});
const OnboardingHeaderStub = defineComponent({
  props: { title: { type: String, default: '' } },
  template: `<header>{{ title }}</header>`,
});

function mountScreen() {
  return mount(LinkDeviceScanScreen, {
    global: { stubs: { MBtn: MBtnStub, OnboardingHeader: OnboardingHeaderStub } },
  });
}

/** A well-formed pairing payload (spec §2): id, pk and s are all present. */
const PAYLOAD = 'matou://pair?v=1&id=abc&pk=pk&s=s&cs=http://localhost:4904';

/** Mount and drive the paste fallback with `payload`, awaiting the scan call. */
async function pasteAndContinue(payload = PAYLOAD) {
  const wrapper = mountScreen();
  const input = wrapper.find('#paste-code');
  await input.setValue(payload);
  // "Continue" is the only button inside the paste box.
  const buttons = wrapper.findAll('button');
  const cont = buttons.find((b) => b.text().trim() === 'Continue');
  await cont!.trigger('click');
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isScannerAvailable.mockReturnValue(true);
  h.getCapacitorPlatform.mockReturnValue('android');
  // Default: status polling never resolves, so the waiting UI stays put.
  h.getStatus.mockReturnValue(new Promise(() => {}));
});

describe('LinkDeviceScanScreen outcomes', () => {
  it('shows the scan button and paste fallback on entry', () => {
    const wrapper = mountScreen();
    expect(wrapper.text()).toContain('Scan the code on your computer');
    expect(wrapper.find('#paste-code').exists()).toBe(true);
    expect(wrapper.text()).toContain("Can't scan? Paste the code");
  });

  it('desktop-to-phone: renders the code and the waiting-for-approval copy', async () => {
    h.scan.mockResolvedValue({
      sessionId: 's1',
      outcome: 'desktop-to-phone',
      code: '482913',
      peerDeviceName: 'Ben’s Laptop',
    });
    const wrapper = await pasteAndContinue();
    expect(wrapper.find('[data-testid="sas-code"]').text()).toBe('482913');
    expect(wrapper.text()).toContain('Waiting for approval on your other device');
  });

  it('renders the SAS code as a string, preserving a leading zero', async () => {
    h.scan.mockResolvedValue({
      sessionId: 's1',
      outcome: 'desktop-to-phone',
      code: '044175',
      peerDeviceName: 'Laptop',
    });
    const wrapper = await pasteAndContinue();
    expect(wrapper.find('[data-testid="sas-code"]').text()).toBe('044175');
  });

  it('phone-to-desktop: renders code, peer name and Approve/Cancel', async () => {
    h.scan.mockResolvedValue({
      sessionId: 's2',
      outcome: 'phone-to-desktop',
      code: '000123',
      peerDeviceName: 'Work Desktop',
    });
    const wrapper = await pasteAndContinue();
    expect(wrapper.find('[data-testid="sas-code"]').text()).toBe('000123');
    expect(wrapper.text()).toContain('Work Desktop');
    const labels = wrapper.findAll('button').map((b) => b.text().trim());
    expect(labels).toContain('Approve');
    expect(labels).toContain('Cancel');
  });

  it('phone-to-desktop: Approve calls approve() then shows Linked on done', async () => {
    h.scan.mockResolvedValue({ sessionId: 's3', outcome: 'phone-to-desktop', code: '111111', peerDeviceName: 'PC' });
    h.approve.mockResolvedValue(undefined);
    h.getStatus.mockResolvedValue({ state: 'done' });
    const wrapper = await pasteAndContinue();
    const approveBtn = wrapper.findAll('button').find((b) => b.text().trim() === 'Approve');
    await approveBtn!.trigger('click');
    await flushPromises();
    expect(h.approve).toHaveBeenCalledWith('s3');
    expect(wrapper.text()).toContain('Linked');
  });

  it('neither: shows the create-or-recover message', async () => {
    h.scan.mockResolvedValue({ sessionId: 's', outcome: 'neither' });
    const wrapper = await pasteAndContinue();
    expect(wrapper.text()).toContain('Neither device has an identity yet');
  });

  it('already-linked: says the devices are already linked', async () => {
    h.scan.mockResolvedValue({ sessionId: 's', outcome: 'already-linked' });
    const wrapper = await pasteAndContinue();
    expect(wrapper.text()).toContain('Already linked');
  });

  it('conflict: refuses and points to signing out first', async () => {
    h.scan.mockResolvedValue({ sessionId: 's', outcome: 'conflict' });
    const wrapper = await pasteAndContinue();
    expect(wrapper.text()).toContain('different identities');
    expect(wrapper.text()).toContain('sign out');
  });

  it('config-server-mismatch: shows a wrong-environment message, stays on input', async () => {
    h.scan.mockRejectedValue(new h.PairingError('mismatch', 400, 'config-server-mismatch'));
    const wrapper = await pasteAndContinue();
    expect(wrapper.text()).toContain("can't be used here");
    expect(wrapper.find('#paste-code').exists()).toBe(true);
  });

  it('desktop-to-phone: retrieves the identity and recovers once approval lands', async () => {
    h.scan.mockResolvedValue({ sessionId: 's4', outcome: 'desktop-to-phone', code: '222222' });
    h.getStatus.mockResolvedValue({ state: 'identity-received' });
    h.fetchIdentity.mockResolvedValue({ mnemonic: 'w '.repeat(11) + 'w', aid: 'EAID', adminAid: 'EADM' });
    h.recoverIdentity.mockResolvedValue({ success: true, aid: 'EAID', name: 'Me' });
    const wrapper = await pasteAndContinue();
    await flushPromises();
    expect(h.fetchIdentity).toHaveBeenCalledWith('s4');
    expect(h.recoverIdentity).toHaveBeenCalledWith(expect.any(String), { mode: 'link', adminAid: 'EADM' });
    // The screen hands off to the welcome overlay via a `continue` emit.
    expect(wrapper.emitted('continue')).toBeTruthy();
  });

  it('hides the scan button when no native scanner is present (still offers paste)', () => {
    h.isScannerAvailable.mockReturnValue(false);
    const wrapper = mountScreen();
    const labels = wrapper.findAll('button').map((b) => b.text().trim());
    expect(labels).not.toContain('Scan the code');
    expect(wrapper.find('#paste-code').exists()).toBe(true);
  });
});

describe('LinkDeviceScanScreen lifecycle (review fixes)', () => {
  it('refuses a pasted payload that is not a matou://pair code without calling the backend', async () => {
    const wrapper = await pasteAndContinue('hello world');
    expect(h.scan).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("doesn't look like a sign-in code");
    expect(wrapper.find('#paste-code').exists()).toBe(true);
  });

  it('refuses a matou://pair payload missing the secret without calling the backend', async () => {
    const wrapper = await pasteAndContinue('matou://pair?v=1&id=abc&pk=pk');
    expect(h.scan).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("doesn't look like a sign-in code");
  });

  it('stops polling on unmount (no leaked timer keeps hitting the backend)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      h.scan.mockResolvedValue({ sessionId: 's5', outcome: 'desktop-to-phone', code: '333333' });
      h.getStatus.mockResolvedValue({ state: 'acked' });
      const wrapper = await pasteAndContinue();
      await vi.advanceTimersByTimeAsync(1500 * 3);
      await flushPromises();
      const before = h.getStatus.mock.calls.length;
      expect(before).toBeGreaterThan(1); // it was polling
      wrapper.unmount();
      await vi.advanceTimersByTimeAsync(1500 * 5);
      await flushPromises();
      expect(h.getStatus.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel while a poll is in flight never fetches the identity or recovers', async () => {
    let resolveStatus!: (s: unknown) => void;
    h.getStatus.mockReturnValue(new Promise((r) => (resolveStatus = r)));
    h.scan.mockResolvedValue({ sessionId: 's6', outcome: 'desktop-to-phone', code: '444444' });
    h.cancel.mockResolvedValue(undefined);
    const wrapper = await pasteAndContinue();
    expect(wrapper.text()).toContain('Waiting for approval');

    const cancelBtn = wrapper.findAll('button').find((b) => b.text().trim() === 'Cancel');
    await cancelBtn!.trigger('click');
    await flushPromises();
    expect(h.cancel).toHaveBeenCalledWith('s6');
    expect(wrapper.find('#paste-code').exists()).toBe(true);

    // The poll that was already in flight now lands with the identity ready.
    resolveStatus({ state: 'identity-received' });
    await flushPromises();
    expect(h.fetchIdentity).not.toHaveBeenCalled();
    expect(h.recoverIdentity).not.toHaveBeenCalled();
    expect(wrapper.emitted('continue')).toBeFalsy();
    // …and the screen is still on the input step, not flipped to "ended".
    expect(wrapper.find('#paste-code').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("Sign-in didn't finish");
  });

  it('unmount while a poll is in flight never fetches the identity or recovers', async () => {
    let resolveStatus!: (s: unknown) => void;
    h.getStatus.mockReturnValue(new Promise((r) => (resolveStatus = r)));
    h.scan.mockResolvedValue({ sessionId: 's7', outcome: 'desktop-to-phone', code: '555555' });
    const wrapper = await pasteAndContinue();
    wrapper.unmount();
    resolveStatus({ state: 'identity-received' });
    await flushPromises();
    expect(h.fetchIdentity).not.toHaveBeenCalled();
    expect(h.recoverIdentity).not.toHaveBeenCalled();
  });

  it('holder: leaving during the approve poll does not flip to Linked', async () => {
    let resolveStatus!: (s: unknown) => void;
    h.getStatus.mockReturnValue(new Promise((r) => (resolveStatus = r)));
    h.scan.mockResolvedValue({ sessionId: 's8', outcome: 'phone-to-desktop', code: '666666', peerDeviceName: 'PC' });
    h.approve.mockResolvedValue(undefined);
    const wrapper = await pasteAndContinue();
    await wrapper.findAll('button').find((b) => b.text().trim() === 'Approve')!.trigger('click');
    await flushPromises();
    expect(h.approve).toHaveBeenCalledWith('s8');
    wrapper.unmount();
    resolveStatus({ state: 'done' });
    await flushPromises();
    expect(wrapper.text()).not.toContain('Linked');
  });

  it('passes the orgAid hint from the identity message to recover()', async () => {
    h.scan.mockResolvedValue({ sessionId: 's9', outcome: 'desktop-to-phone', code: '777777' });
    h.getStatus.mockResolvedValue({ state: 'identity-received' });
    h.fetchIdentity.mockResolvedValue({ mnemonic: 'w '.repeat(11) + 'w', aid: 'EAID', orgAid: 'EORG' });
    h.recoverIdentity.mockResolvedValue({ success: true, aid: 'EAID', name: 'Me' });
    await pasteAndContinue();
    await flushPromises();
    expect(h.recoverIdentity).toHaveBeenCalledWith(expect.any(String), { mode: 'link', orgAid: 'EORG' });
  });

  it('a failed link-mode recovery ends the flow with its reason instead of continuing', async () => {
    h.scan.mockResolvedValue({ sessionId: 's10', outcome: 'desktop-to-phone', code: '888888' });
    h.getStatus.mockResolvedValue({ state: 'identity-received' });
    h.fetchIdentity.mockResolvedValue({ mnemonic: 'w '.repeat(11) + 'w', aid: 'EAID' });
    h.recoverIdentity.mockResolvedValue({ success: false, error: 'No identity found for this recovery phrase.' });
    const wrapper = await pasteAndContinue();
    await flushPromises();
    expect(wrapper.emitted('continue')).toBeFalsy();
    expect(wrapper.text()).toContain("Sign-in didn't finish");
    expect(wrapper.text()).toContain('No identity found for this recovery phrase.');
  });

  it('a failed backend cancel is swallowed (no unhandled rejection) and the screen resets', async () => {
    h.scan.mockResolvedValue({ sessionId: 's11', outcome: 'desktop-to-phone', code: '999999' });
    h.cancel.mockRejectedValue(new h.PairingError('session not found', 404, 'session not found'));
    const wrapper = await pasteAndContinue();
    const cancelBtn = wrapper.findAll('button').find((b) => b.text().trim() === 'Cancel');
    await cancelBtn!.trigger('click');
    await flushPromises();
    expect(h.cancel).toHaveBeenCalledWith('s11');
    expect(wrapper.find('#paste-code').exists()).toBe(true);
  });
});
