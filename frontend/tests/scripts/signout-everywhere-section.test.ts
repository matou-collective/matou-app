// @vitest-environment happy-dom
/**
 * SignOutEverywhereSection — the identity screen's take-back row (#665, ADR 0282
 * d.4). Proves the copy is exact, that there is NO session list / device name /
 * count anywhere (AC1), that the done and failure states read as specified
 * (AC3/AC4), and that the "replace your twelve words" line is absent until idss
 * #1914's re-key screen lands (AC5). The composable is stubbed so the mount stays
 * a template test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Ref } from 'vue';

const state = vi.hoisted(() => ({
  value: 'idle' as 'idle' | 'working' | 'done' | 'failed',
  signOut: vi.fn(async () => {}),
  reset: vi.fn(() => {}),
}));

// The composable is stubbed: `status` is a fresh ref carrying the value the test
// set before mount (useSignoutEverywhere is called during mount), and signOut /
// reset are spies.
vi.mock('src/composables/useSignoutEverywhere', async () => {
  const { ref: makeRef } = await import('vue');
  return {
    useSignoutEverywhere: () => ({
      status: makeRef(state.value) as Ref<'idle' | 'working' | 'done' | 'failed'>,
      signOut: state.signOut,
      reset: state.reset,
    }),
  };
});

import SignOutEverywhereSection from 'src/components/settings/SignOutEverywhereSection.vue';

function setStatus(s: 'idle' | 'working' | 'done' | 'failed') {
  state.value = s;
}

beforeEach(() => {
  state.value = 'idle';
  state.signOut.mockClear();
  state.reset.mockClear();
});

/** Words that would betray a session list, device names or a count (forbidden). */
const FORBIDDEN = /\b(\d+\s+(session|device|tab|computer)s?|session list|device name|ip address)\b/i;

describe('SignOutEverywhereSection', () => {
  it('renders the row copy with one button and no session list / count (AC1)', () => {
    const w = mount(SignOutEverywhereSection);
    const text = w.text();
    expect(text).toContain('Sign out of the control panel everywhere');
    expect(text).toContain("Locks steward actions on every computer you've unlocked");
    expect(text).toContain('You stay a steward');
    expect(text).toContain("It can't take back anything already done with it");
    const btn = w.find('[data-test="signout-everywhere-btn"]');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain('Sign out everywhere');
    // No count, session list, device name or IP anywhere.
    expect(text).not.toMatch(FORBIDDEN);
  });

  it('omits the "replace your twelve words" line until idss #1914 lands (AC5)', () => {
    const w = mount(SignOutEverywhereSection);
    expect(w.find('[data-test="signout-everywhere-rekey"]').exists()).toBe(false);
    expect(w.text()).not.toContain('twelve words');
    // And it never names a passcode — DDR 0284 (a steward holds twelve words).
    expect(w.text().toLowerCase()).not.toContain('passcode');
  });

  it('pressing the button runs the take-back (AC2)', async () => {
    const w = mount(SignOutEverywhereSection);
    await w.find('[data-test="signout-everywhere-btn"]').trigger('click');
    expect(state.signOut).toHaveBeenCalledTimes(1);
  });

  it('the working state disables the button and says so', () => {
    setStatus('working');
    const w = mount(SignOutEverywhereSection);
    const btn = w.find('[data-test="signout-everywhere-btn"]');
    expect(btn.attributes('disabled')).toBeDefined();
    expect(btn.text()).toContain('Signing out');
  });

  it('the done state reads as specified with NO count (AC3)', () => {
    setStatus('done');
    const w = mount(SignOutEverywhereSection);
    const done = w.find('[data-test="signout-everywhere-done"]');
    expect(done.exists()).toBe(true);
    expect(w.text()).toContain('Signed out of the control panel everywhere.');
    expect(w.text()).toContain('Any computer that was unlocked will ask to sign in again.');
    expect(w.text()).toContain("You're still a steward. Your app is unchanged.");
    expect(w.text()).not.toMatch(FORBIDDEN);
    // The action button is gone in the done state.
    expect(w.find('[data-test="signout-everywhere-btn"]').exists()).toBe(false);
  });

  it('the failure state is plain and claims nothing ended, offering a retry (AC4)', async () => {
    setStatus('failed');
    const w = mount(SignOutEverywhereSection);
    expect(w.find('[data-test="signout-everywhere-failed"]').exists()).toBe(true);
    expect(w.text()).toContain("Couldn't sign out of the control panel.");
    expect(w.text()).toContain('Nothing changed — no sessions were ended.');
    const retry = w.find('[data-test="signout-everywhere-retry"]');
    expect(retry.exists()).toBe(true);
    await retry.trigger('click');
    expect(state.reset).toHaveBeenCalledTimes(1);
    expect(state.signOut).toHaveBeenCalledTimes(1);
  });
});
