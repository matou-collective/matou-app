// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

const { default: StewardInboxNotice } = await import('../../src/components/dashboard/StewardInboxNotice.vue');

describe('StewardInboxNotice (#709)', () => {
  it('shows the inbox message when lastError is non-null', () => {
    const w = mount(StewardInboxNotice, {
      props: { message: '2 change(s) from other stewards could not be applied by this wallet' },
    });
    expect(w.find('[data-test="steward-inbox-notice"]').exists()).toBe(true);
    expect(w.text()).toContain('2 change(s) from other stewards could not be applied by this wallet');
  });

  it('shows a notice from a positive pending count even when lastError is null', () => {
    const w = mount(StewardInboxNotice, {
      props: { message: null, pendingCount: 3 },
    });
    expect(w.find('[data-test="steward-inbox-notice"]').exists()).toBe(true);
    expect(w.text()).toContain('3 change(s) from other stewards not applied yet');
  });

  it('renders nothing when the inbox is clean (no message, no pending, no skipped)', () => {
    const w = mount(StewardInboxNotice, {
      props: { message: null, pendingCount: 0, affected: [] },
    });
    expect(w.find('[data-test="steward-inbox-notice"]').exists()).toBe(false);
    expect(w.text()).toBe('');
  });

  it('lists affected members behind a toggle, resolving names and falling back to the SAID', async () => {
    const w = mount(StewardInboxNotice, {
      props: {
        message: 'skipped',
        affected: [
          { said: 'EABC1234567890xxxxxxxxxx', name: 'Aroha' },
          { said: 'EDEF9876543210yyyyyyyyyy', name: null },
        ],
      },
    });
    // The list is collapsed until the steward expands it.
    expect(w.find('[data-test="steward-inbox-affected-list"]').exists()).toBe(false);
    await w.get('[data-test="steward-inbox-toggle"]').trigger('click');

    const items = w.findAll('[data-test="steward-inbox-affected"]');
    expect(items).toHaveLength(2);
    expect(items[0]!.text()).toBe('Aroha');
    // Unresolved holder → truncated SAID, never a blank row.
    expect(items[1]!.text()).toBe('EDEF98765432…');
  });

  it('offers no affected-members toggle when there is nothing to list', () => {
    const w = mount(StewardInboxNotice, { props: { message: 'skipped', affected: [] } });
    expect(w.find('[data-test="steward-inbox-toggle"]').exists()).toBe(false);
  });
});
