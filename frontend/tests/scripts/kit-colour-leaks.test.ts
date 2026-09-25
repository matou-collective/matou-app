import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #636 — the onboarding screens and the header-gradient surfaces must render in
 * the community's brand kit, never in Mātou's own palette. So those files must
 * not hard-code Mātou's teal literals (#1e5f74 / #4a9d9c / #7eb3b8 / the
 * rgba(30, 95, 116, …) washes); every brand colour has to come through a
 * --matou-* token (which apply-kit fills from the kit). A CSS-variable *fallback*
 * that happens to name a literal is still a leak in dark mode, so we forbid the
 * literals outright in these surfaces.
 */
const ROOT = join(__dirname, '../../src');
const MATOU_PALETTE = /#7eb3b8|#1e5f74|#4a9d9c|rgba\(\s*30\s*,\s*95\s*,\s*116/gi;

// The onboarding flow + the standalone brand surfaces named in #636. These are
// fully swept — zero Mātou colour literals allowed.
const SWEPT = [
  ...readdirSync(join(ROOT, 'components/onboarding')).map((f) => `components/onboarding/${f}`),
  'components/setup/OrgSetupScreen.vue',
  'components/dashboard/InviteMemberModal.vue',
].filter((f) => f.endsWith('.vue'));

// Header-gradient surfaces must all use the one shared token, not a bespoke
// gradient with a hard-coded Mātou stop.
const GRADIENT_SURFACES = [
  'components/onboarding/SplashScreen.vue',
  'components/onboarding/OnboardingHeader.vue',
  'components/onboarding/WelcomeOverlayScreen.vue',
  'components/onboarding/ProfileConfirmationScreen.vue',
  'components/setup/OrgSetupScreen.vue',
  'components/dashboard/InviteMemberModal.vue',
  'pages/DashboardPage.vue',
];

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('#636 onboarding + brand surfaces carry no Mātou colour literals', () => {
  for (const rel of SWEPT) {
    it(rel, () => {
      const hits = read(rel).match(MATOU_PALETTE) ?? [];
      expect(hits, `${rel} hard-codes a Mātou palette literal (${hits.join(', ')}) — use a --matou-* token`).toEqual([]);
    });
  }
});

describe('#636 the shared header gradient', () => {
  it('design-tokens defines the theme-invariant --matou-brand-gradient token', () => {
    const css = read('css/design-tokens.scss');
    expect(css).toContain('--matou-brand-secondary:');
    expect(css).toMatch(
      /--matou-brand-gradient:\s*linear-gradient\(to top left, var\(--matou-brand-secondary\), var\(--matou-brand\)\)/,
    );
  });

  it('dark mode no longer hard-codes Mātou teal as --matou-primary', () => {
    const dark = read('css/design-tokens.scss').match(/\.dark\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    // --matou-primary / --matou-primary-foreground now come from the kit's .dark
    // block (kit-tokens.scss), not this hardcoded Mātou override. (The chart /
    // sidebar palette here is the stock default set and out of #636's scope.)
    expect(dark).not.toContain('--matou-primary:');
    expect(dark).not.toContain('--matou-primary-foreground:');
  });

  for (const rel of GRADIENT_SURFACES) {
    it(`${rel} uses var(--matou-brand-gradient)`, () => {
      expect(read(rel)).toContain('var(--matou-brand-gradient)');
    });
  }
});
