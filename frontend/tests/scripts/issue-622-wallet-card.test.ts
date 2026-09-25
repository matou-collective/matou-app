// @vitest-environment happy-dom
/**
 * Issue #622 — the wallet's Credentials tab.
 *
 * 1. In a Coa build (kit slug ≠ `matou`) the Cards/Graph toggle and the
 *    relationship graph are hidden; stock Mātou keeps both.
 * 2. Each credential renders as the IDSS control panel's card: a mark tile, a
 *    status pill, a bold name and a Received/Issued tag. A credential with a
 *    `display.background` paints the whole card (with contrast ink); one
 *    without renders the same shape unpainted.
 *
 * Runs under happy-dom. The stores, generated kit and heavy api/keri modules
 * are stubbed so the mounts stay template tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { defineComponent } from 'vue';
import type { WalletCredential } from 'stores/wallet';

// happy-dom has no ResizeObserver; CredentialsTab installs one on mount.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;

// Mutable mocks — hoisted so the vi.mock factories (also hoisted) can close
// over them. Flip the kit slug / seed credentials per test.
const kitMock = vi.hoisted(() => ({
  KIT: { slug: 'matou', brand: { name: 'Test Community' } },
}));
const walletState = vi.hoisted(() => ({
  credentials: [] as unknown[],
  credentialsLoading: false,
  credentialsError: null as string | null,
}));

vi.mock('src/generated/kit', () => kitMock);

vi.mock('src/composables/useAdminActions', () => ({
  ENDORSEMENT_SCHEMA_SAID: 'EENDORSESCHEMA',
  EVENT_ATTENDANCE_SCHEMA_SAID: 'EEVENTSCHEMA',
}));
vi.mock('src/lib/api/client', () => ({ getFileUrl: (p: string) => p }));

vi.mock('stores/wallet', () => ({ useWalletStore: () => walletState }));
vi.mock('stores/profiles', () => ({
  useProfilesStore: () => ({ communityProfiles: [], getMyProfile: () => null }),
}));
vi.mock('stores/identity', () => ({
  useIdentityStore: () => ({ currentAID: null, aidPrefix: '' }),
}));
vi.mock('stores/app', () => ({ useAppStore: () => ({ orgAid: '' }) }));

import CredentialsTab from 'src/components/wallet/CredentialsTab.vue';
import WalletCredentialCard from 'src/components/wallet/WalletCredentialCard.vue';

function makeCred(overrides: Partial<WalletCredential> = {}): WalletCredential {
  return {
    said: 'ECRED0000000000000000000000000000000000000000',
    schemaSaid: 'ESCHEMA',
    schemaTitle: 'Mātou Membership',
    issuerAid: 'EISSUER',
    issueeAid: 'EISSUEE',
    communityName: 'Test Community',
    role: 'Member',
    issuedAt: '2026-09-20T00:00:00Z',
    status: '0',
    claim: '',
    eventName: '',
    committee: '',
    ...overrides,
  } as WalletCredential;
}

const CardStub = defineComponent({
  name: 'WalletCredentialCard',
  props: { credential: { type: Object, required: true } },
  template: '<div class="card-stub" />',
});
const DialogStub = defineComponent({ template: '<div />' });

function mountTab() {
  setActivePinia(createPinia());
  return mount(CredentialsTab, {
    global: {
      stubs: {
        WalletCredentialCard: CardStub,
        CredentialDetailDialog: DialogStub,
      },
    },
  });
}

beforeEach(() => {
  kitMock.KIT.slug = 'matou';
  walletState.credentials = [makeCred()];
  walletState.credentialsLoading = false;
  walletState.credentialsError = null;
});

describe('CredentialsTab — Coa gate (#622)', () => {
  it('hides the Cards/Graph toggle and the graph in a Coa build', () => {
    kitMock.KIT.slug = 'whakatohea-demo';
    const wrapper = mountTab();

    expect(wrapper.find('.view-toggle').exists()).toBe(false);
    expect(wrapper.text()).not.toMatch(/Graph/);
    // Credentials render as cards; the graph is never rendered.
    expect(wrapper.find('.graph-view').exists()).toBe(false);
    expect(wrapper.findAll('.card-stub').length).toBe(1);

    wrapper.unmount();
  });

  it('keeps the toggle and can show the graph on stock Mātou', async () => {
    const wrapper = mountTab();

    expect(wrapper.find('.view-toggle').exists()).toBe(true);
    const graphBtn = wrapper
      .findAll('button.toggle-btn')
      .find((b) => b.text().includes('Graph'));
    expect(graphBtn).toBeTruthy();

    await graphBtn!.trigger('click');
    expect(wrapper.find('.graph-view').exists()).toBe(true);

    wrapper.unmount();
  });
});

describe('WalletCredentialCard — control-panel shape (#622)', () => {
  const mountCard = (props: Record<string, unknown>) =>
    mount(WalletCredentialCard, {
      props: {
        name: 'Finance komiti',
        tag: 'Received',
        statusLabel: 'Active',
        statusTone: 'healthy',
        footer: '20 Sep 2026',
        ...props,
      },
      global: { stubs: { CredentialMark: true } },
    });

  it('paints the whole card with the display background and contrast ink', () => {
    const cred = makeCred({
      display: { name: 'Finance komiti', icon: 'landmark', background: '#0a5c6b' },
    });
    const wrapper = mountCard({ credential: cred });

    const card = wrapper.find('.wallet-cred-card');
    expect(card.classes()).toContain('painted');
    // Background + ink applied inline so currentColor-based bits follow it.
    const style = card.attributes('style') || '';
    expect(style).toMatch(/background/);
    expect(style).toMatch(/color/);
    // The pill echoes the contrast ink rather than a fixed tone.
    expect(wrapper.find('.cred-pill').classes()).toContain('pill-painted');
    // Shape: tile, pill, bold name, tag.
    expect(wrapper.find('.cred-tile').exists()).toBe(true);
    expect(wrapper.find('.cred-name').text()).toBe('Finance komiti');
    expect(wrapper.find('.cred-tag').text()).toBe('Received');

    wrapper.unmount();
  });

  it('renders the same shape unpainted when there is no display', () => {
    const cred = makeCred({ display: undefined });
    const wrapper = mountCard({
      credential: cred,
      name: 'Mātou Membership',
      tag: 'Issued',
      statusLabel: 'Revoked',
      statusTone: 'warning',
      recipient: 'To: MĀTOU',
    });

    const card = wrapper.find('.wallet-cred-card');
    expect(card.classes()).not.toContain('painted');
    expect(card.attributes('style')).toBeFalsy();
    // Tone falls to the fixed warning pill, not the painted one.
    const pill = wrapper.find('.cred-pill');
    expect(pill.classes()).toContain('warning');
    expect(pill.classes()).not.toContain('pill-painted');
    // Same shape: tile, name, tag, and the recipient footer.
    expect(wrapper.find('.cred-tile').exists()).toBe(true);
    expect(wrapper.find('.cred-name').text()).toBe('Mātou Membership');
    expect(wrapper.find('.cred-tag').text()).toBe('Issued');
    expect(wrapper.find('.cred-recipient').text()).toBe('To: MĀTOU');

    wrapper.unmount();
  });
});
