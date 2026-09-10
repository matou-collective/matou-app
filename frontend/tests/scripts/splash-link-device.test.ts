/**
 * "Sign in with your computer" landing button (#473, spec §1).
 *
 * On mobile (Capacitor) the splash offers linked-device sign-in *above* "Join
 * Now", with copy steering members away from minting a second identity. This
 * is the cheapest defence against a second registration, so the placement and
 * the gate matter. happy-dom can't compute the Capacitor gate at mount time
 * without a heavy shim, so — like kit-chrome.test.ts's colour check — we assert
 * on the SFC source: the button + sub-copy exist, sit above "Join Now", and are
 * gated on the Capacitor check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SFC = readFileSync(
  join(__dirname, '../../src/components/onboarding/SplashScreen.vue'),
  'utf8',
);

describe('SplashScreen linked-device button', () => {
  it('offers "Sign in with your computer" with the anti-second-registration copy', () => {
    expect(SFC).toContain('Sign in with your computer');
    expect(SFC).toContain(
      'Already a member on your computer? Sign in here instead of joining again.',
    );
  });

  it('places the linked-device button above "Join Now"', () => {
    // Compare the two button elements by their unique classes (the label
    // "Join Now" also appears in the placement comment, so match on markup).
    const linkBtnIdx = SFC.indexOf('link-device-btn');
    const registerBtnIdx = SFC.indexOf('register-btn');
    expect(linkBtnIdx).toBeGreaterThan(-1);
    expect(registerBtnIdx).toBeGreaterThan(-1);
    expect(linkBtnIdx).toBeLessThan(registerBtnIdx);
  });

  it('gates the button on the Capacitor shell', () => {
    // showLinkDevice = isCapacitor(); the button renders under v-if="showLinkDevice".
    expect(SFC).toMatch(/showLinkDevice\s*=\s*isCapacitor\(\)/);
    expect(SFC).toMatch(/v-if="showLinkDevice"/);
    expect(SFC).toMatch(/import\s*\{\s*isCapacitor\s*\}\s*from\s*'src\/lib\/capacitor'/);
  });

  it('emits `link` when tapped', () => {
    expect(SFC).toMatch(/@click="onLinkDevice"/);
    expect(SFC).toMatch(/emit\('link'\)/);
  });
});
