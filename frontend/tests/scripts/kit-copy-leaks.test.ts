import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A kit build must not show Mātou's own name, domain or links to a member of
 * another community (#452). Onboarding copy comes from KIT.brand / KIT.onboarding;
 * anything still hard-coded is listed here with its *remaining* count so a new
 * leak fails the test and the allowlist shrinks as the product half lands.
 */
const ROOT = join(__dirname, '../../src');
const LEAK = /Mātou|matou\.nz/g;

// file -> number of literals still allowed (the "product half" of #452:
// resources cards + Mātou's own guidelines/information content).
const ALLOWED: Record<string, number> = {
  'components/onboarding/MatouInformationContent.vue': Infinity, // Mātou's about/expectations block (claim path, guidelines page)
  'components/onboarding/PendingApprovalScreen.vue': 3, // "Learn more about Mātou" + two docs.matou.nz resource links
  'pages/CommunityGuidelinesPage.vue': Infinity, // Mātou's guidelines verbatim, pending a kit field
};

function count(rel: string): number {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  // Strip the scoped styles: --matou-* CSS variables are the design system, not copy.
  const body = src.replace(/<style[\s\S]*?<\/style>/g, '');
  return (body.match(LEAK) ?? []).length;
}

describe('kit builds do not leak Mātou copy into onboarding', () => {
  const files = [
    ...readdirSync(join(ROOT, 'components/onboarding')).map((f) => `components/onboarding/${f}`),
    'pages/OnboardingPage.vue',
    'pages/CommunityGuidelinesPage.vue',
    'layouts/OnboardingLayout.vue',
    // The Devices card (#474) names the app in its copy — it must come from
    // KIT.brand.name, like every other branded string.
    'pages/AccountSettingsPage.vue',
  ].filter((f) => f.endsWith('.vue'));

  for (const rel of files) {
    it(rel, () => {
      const allowed = ALLOWED[rel] ?? 0;
      expect(count(rel), `${rel} hard-codes Mātou copy — use KIT.brand.name / KIT.brand.contactEmail`).toBeLessThanOrEqual(allowed);
    });
  }

  it('allowlist entries are still needed (shrink it when the product half lands)', () => {
    for (const [rel, allowed] of Object.entries(ALLOWED)) {
      if (allowed !== Infinity) expect(count(rel), rel).toBe(allowed);
    }
  });
});
