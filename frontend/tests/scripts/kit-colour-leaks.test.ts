import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * #642 (widening #636) — every colour the app draws must come from the kit, so
 * NO file under src may hard-code a Mātou palette literal: the teals
 * (#1e5f74 / #4a9d9c / #7eb3b8), the navy dark surfaces (#0f1a23 / #1a2b3a /
 * #e8f4f8), the warm accent (#e57e24) or any of their rgba() forms. Brand colour
 * flows through the --matou-* tokens (apply-kit fills primary/secondary/accent
 * from the kit; design-tokens.scss derives the rest with color-mix over them). A
 * CSS-variable *fallback* that names a literal is still a leak in a community
 * build, so the literals are forbidden outright.
 *
 * The ONLY place a stock-Mātou literal is legitimate is the generated kit-default
 * files (they ARE the stock kit): src/generated/** and src/css/kit-tokens.scss.
 */
const ROOT = join(__dirname, '../../src');
const MATOU_PALETTE =
  /#1e5f74|#4a9d9c|#7eb3b8|#e57e24|#0f1a23|#1a2b3a|#e8f4f8|rgba\(\s*30\s*,\s*95\s*,\s*116|rgba\(\s*74\s*,\s*157\s*,\s*156|rgba\(\s*126\s*,\s*179\s*,\s*184|rgba\(\s*232\s*,\s*244\s*,\s*248/gi;

// The generated stock-kit defaults — these files ARE the stock kit, so the
// Mātou literals in them are the kit values, not a leak.
const ALLOWLIST = [/^generated\//, /^css\/kit-tokens\.scss$/];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(vue|scss|ts)$/.test(entry)) acc.push(full);
  }
  return acc;
}

const files = walk(ROOT)
  .map((f) => relative(ROOT, f))
  .filter((rel) => !ALLOWLIST.some((re) => re.test(rel)))
  .sort();

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('#642 no Mātou colour literal anywhere under src (outside the generated kit defaults)', () => {
  for (const rel of files) {
    it(rel, () => {
      const hits = read(rel).match(MATOU_PALETTE) ?? [];
      expect(
        hits,
        `${rel} hard-codes a Mātou palette literal (${hits.join(', ')}) — use a --matou-* token / color-mix over one`,
      ).toEqual([]);
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
  for (const rel of GRADIENT_SURFACES) {
    it(`${rel} uses var(--matou-brand-gradient)`, () => {
      expect(read(rel)).toContain('var(--matou-brand-gradient)');
    });
  }
});
