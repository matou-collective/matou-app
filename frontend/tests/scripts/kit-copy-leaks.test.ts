import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * #642 (widening #452) — a kit build must not show Mātou's own name or domain to
 * a member of another community. User-facing copy comes from KIT.brand.name /
 * KIT.brand.contactEmail (or is hidden in a Coa build when it's Mātou-only). This
 * guard is now APP-WIDE: it scans every .vue under src (template + script, minus
 * <style> and comments) for a hard-coded `Mātou` / `matou.nz`.
 *
 * Comments and internal identifiers are explicitly out of scope (per #642) — so
 * we strip <style>, HTML comments, block comments and full-line `//`/`*` comment
 * lines before counting, and we do not scan .ts (endpoints/constants/JSDoc).
 * URLs embedded in real strings (e.g. `https://docs.matou.nz`) survive stripping
 * and are still caught.
 */
const ROOT = join(__dirname, '../../src');
const LEAK = /Mātou|matou\.nz/g;

// file -> number of literals still allowed. Mātou's own product content
// (about/guidelines pages) and genuinely Mātou-specific chrome.
const ALLOWED: Record<string, number> = {
  'components/onboarding/MatouInformationContent.vue': Infinity, // Mātou's about/expectations block (claim path, guidelines page)
  'components/onboarding/PendingApprovalScreen.vue': 3, // "Learn more about Mātou" + two docs.matou.nz resource links — rendered only in the stock build (gated on !isCoa, asserted below)
  'pages/CommunityGuidelinesPage.vue': Infinity, // Mātou's guidelines verbatim, pending a kit field
  'components/wallet/CredentialMark.vue': 1, // alt text on a *legacy Mātou* credential mark (isLegacyMatou) — describes an actual Mātou-issued credential
};

function strip(src: string): string {
  const noStyle = src
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '') // HTML comments
    .replace(/\/\*[\s\S]*?\*\//g, ''); // block comments
  return noStyle
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)) // full-line // and JSDoc * continuations
    .join('\n');
}

function count(rel: string): number {
  return (strip(readFileSync(join(ROOT, rel), 'utf8')).match(LEAK) ?? []).length;
}

function walkVue(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkVue(full, acc);
    else if (entry.endsWith('.vue')) acc.push(relative(ROOT, full));
  }
  return acc;
}

describe('#642 kit builds do not leak Mātou copy anywhere in the app', () => {
  for (const rel of walkVue(ROOT).sort()) {
    it(rel, () => {
      const allowed = ALLOWED[rel] ?? 0;
      expect(
        count(rel),
        `${rel} hard-codes Mātou copy — use KIT.brand.name / KIT.brand.contactEmail`,
      ).toBeLessThanOrEqual(allowed);
    });
  }

  it('allowlist entries are still needed (shrink it when the product half lands)', () => {
    for (const [rel, allowed] of Object.entries(ALLOWED)) {
      if (allowed !== Infinity) expect(count(rel), rel).toBe(allowed);
    }
  });
});

// The "Explore while you wait" block is the stock build's own docs: a Coa build
// must never render it (Ben, 2026-09-25), so its v-if carries the isCoa gate.
describe('PendingApprovalScreen hides the stock docs block in a Coa build', () => {
  it('gates the Explore-while-you-wait section on !isCoa', () => {
    const src = readFileSync(join(ROOT, 'components/onboarding/PendingApprovalScreen.vue'), 'utf8');
    const block = src.slice(src.indexOf('<!-- Resources'), src.indexOf('Explore while you wait'));
    expect(block).toMatch(/v-if="[^"]*!isCoa[^"]*"/);
    expect(src).toContain('const isCoa = isCoaBuild();');
  });
});
