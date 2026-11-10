// @vitest-environment happy-dom
/**
 * Wallet token tabs are stock Mātou's roadmap placeholders (#619).
 *
 * The Governance Tokens and Transaction Tokens entries promise a token economy
 * a Coa-built community app never chose. So the wallet sidebar shows them only
 * in stock Mātou (kit slug 'matou'); in a Coa build (any other slug) the page
 * shows only Credentials — no token entries, no "Coming soon", and the subtitle
 * drops "and community tokens".
 *
 * Each case resets the module graph, mocks the generated kit to the slug under
 * test and stubs the wallet store + tab components, then mounts WalletPage.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

async function mountWalletPage(slug: string) {
  vi.resetModules();
  vi.doMock('src/generated/kit', () => ({
    KIT: { slug, features: {} },
    KIT_BUILD: {},
  }));
  vi.doMock('stores/wallet', () => ({
    useWalletStore: () => ({ refreshAll: vi.fn() }),
  }));
  const { mount } = await import('@vue/test-utils');
  const { default: WalletPage } = await import('../../src/pages/WalletPage.vue');
  setActivePinia(createPinia());
  return mount(WalletPage, {
    global: {
      stubs: {
        CredentialsTab: { template: '<div class="credentials-tab-stub" />' },
        GovernanceTokensTab: { template: '<div class="gov-tab-stub" />' },
        TransactionTokensTab: { template: '<div class="tx-tab-stub" />' },
      },
    },
  });
}

afterEach(() => {
  vi.doUnmock('src/generated/kit');
  vi.doUnmock('stores/wallet');
});

describe('WalletPage token tabs by kit (#619)', () => {
  it('stock Mātou shows Credentials, Governance and Transaction tokens', async () => {
    const wrapper = await mountWalletPage('matou');
    const text = wrapper.text();
    expect(text).toContain('Credentials');
    expect(text).toContain('Governance Tokens');
    expect(text).toContain('Transaction Tokens');
    expect(text).toContain('Coming soon');
    expect(text).toContain('and community tokens');
    wrapper.unmount();
  });

  it('a Coa build shows only Credentials — no token entries or wording', async () => {
    const wrapper = await mountWalletPage('whakatohea-demo');
    const text = wrapper.text();
    expect(text).toContain('Credentials');
    expect(text).not.toContain('Governance Tokens');
    expect(text).not.toContain('Transaction Tokens');
    expect(text).not.toContain('Coming soon');
    expect(text).not.toContain('community tokens');
    // The token tab components are never rendered either.
    expect(wrapper.find('.gov-tab-stub').exists()).toBe(false);
    expect(wrapper.find('.tx-tab-stub').exists()).toBe(false);
    wrapper.unmount();
  });
});
