import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyKit, isSoftTint, tokensScss } from '../../scripts/kit/apply-kit.mjs';

const REPO = join(__dirname, '..', '..', '..');
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kit-'));
  // minimal skeleton of the files apply-kit patches
  await mkdir(join(root, 'src-capacitor/android/app/src/main/res/values'), { recursive: true });
  await mkdir(join(root, 'src/generated'), { recursive: true });
  await mkdir(join(root, 'src/css'), { recursive: true });
  await writeFile(join(root, 'src-capacitor/capacitor.config.json'), JSON.stringify({ appId: 'nz.matou.app', appName: 'Matou', webDir: 'www', plugins: { MatouBackend: { configServerUrl: '' } } }, null, 2));
  await writeFile(join(root, 'src-capacitor/android/app/src/main/res/values/strings.xml'), `<?xml version='1.0' encoding='utf-8'?>\n<resources>\n    <string name="app_name">Matou</string>\n    <string name="title_activity_main">Matou</string>\n    <string name="package_name">nz.matou.app</string>\n    <string name="custom_url_scheme">nz.matou.app</string>\n</resources>\n`);
  await writeFile(join(root, 'src-capacitor/android/app/build.gradle'), `android {\n    namespace "nz.matou.app"\n    defaultConfig {\n        applicationId "nz.matou.app"\n    }\n}\n`);
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function kitDir(overrides: Record<string, unknown> = {}) {
  const dir = join(root, 'kit');
  await mkdir(dir);
  const base = JSON.parse(await readFile(join(REPO, 'coa-kit/kit.json'), 'utf8'));
  await writeFile(join(dir, 'kit.json'), JSON.stringify({ ...base, ...overrides }));
  await cp(join(REPO, 'coa-kit/logo.png'), join(dir, 'logo.png'));
  return dir;
}

describe('apply-kit (core)', () => {
  it('the default kit reproduces upstream identities', async () => {
    await applyKit(await kitDir(), root, { icons: false });
    const build = JSON.parse(await readFile(join(root, 'kit.build.json'), 'utf8'));
    // productName is the OS-facing packaging identity and is diacritic-folded to ASCII
    // (apply-kit.mjs), while brand.name keeps its macrons everywhere users read.
    expect(build).toMatchObject({ appId: 'org.matou.app', productName: 'Matou', artifactBase: 'matou', executableName: 'matou', androidApplicationId: 'nz.matou.app', updates: true, primaryColour: '#1E5F74' });
    expect(build.publish).toEqual([{ provider: 'github', owner: 'matou-collective', repo: 'matou-app', releaseType: 'draft' }]);
    expect(await readFile(join(root, 'src-capacitor/android/app/build.gradle'), 'utf8')).toContain('applicationId "nz.matou.app"');
    const tokens = await readFile(join(root, 'src/css/kit-tokens.scss'), 'utf8');
    expect(tokens).toContain('$kit-primary: #1E5F74;');
    expect(tokens).toContain('--matou-primary: #1E5F74;');
    // Stock secondary #E8F4F8 is already a pale tint → kept solid (unchanged
    // look), and the selected-nav / dark values match the pre-#337 hardcodes.
    expect(tokens).toContain('--matou-secondary: #E8F4F8;');
    expect(tokens).toContain('--matou-muted: #E8F4F8;');
    expect(tokens).toContain('--matou-secondary-strong: #E8F4F8;');
    expect(tokens).toContain('--matou-sidebar-accent: #E8F4F8;');
    expect(tokens).not.toContain('color-mix');
    expect(tokens).toMatch(/\.dark\s*\{[^}]*--matou-secondary: #1e3340;/);
    const kitTs = await readFile(join(root, 'src/generated/kit.ts'), 'utf8');
    expect(kitTs).toContain("export const KIT");
    // Pin the split so the two can't drift apart again: brand.name (in kit.ts) keeps its
    // macron, while productName (packaging identity) is folded to ASCII.
    expect(kitTs).toContain('"name": "Mātou"');
    expect(build.productName).toBe('Matou');
  });
  it('a community kit gets coa identities, no publish, no updates', async () => {
    await applyKit(await kitDir({ slug: 'ngati-example', brand: { name: 'Ngāti Example', slug: 'ngati-example', primaryColour: '#0A5C6B', secondaryColour: '#F2B134', contactEmail: 'k@x.nz' } }), root, { icons: false });
    const build = JSON.parse(await readFile(join(root, 'kit.build.json'), 'utf8'));
    expect(build).toMatchObject({ appId: 'org.matou.coa.ngati-example', productName: 'Ngati Example', artifactBase: 'ngati-example', executableName: 'ngati-example', androidApplicationId: 'org.matou.coa.ngati_example', urlScheme: 'org.matou.coa.ngati-example', publish: null, updates: false });
    expect(JSON.parse(await readFile(join(root, 'src-capacitor/capacitor.config.json'), 'utf8'))).toMatchObject({ appId: 'org.matou.coa.ngati_example', appName: 'Ngāti Example' });
    const strings = await readFile(join(root, 'src-capacitor/android/app/src/main/res/values/strings.xml'), 'utf8');
    expect(strings).toContain('<string name="app_name">Ngāti Example</string>');
    expect(strings).toContain('<string name="package_name">org.matou.coa.ngati_example</string>');
    const gradle = await readFile(join(root, 'src-capacitor/android/app/build.gradle'), 'utf8');
    expect(gradle).toContain('namespace "nz.matou.app"');
    expect(gradle).toContain('applicationId "org.matou.coa.ngati_example"');
    // URL schemes may not contain '_' (RFC 3986) — the scheme keeps the hyphenated slug
    expect(strings).toContain('<string name="custom_url_scheme">org.matou.coa.ngati-example</string>');
    const tokens = await readFile(join(root, 'src/css/kit-tokens.scss'), 'utf8');
    // Full-strength secondary stays available…
    expect(tokens).toContain('$kit-secondary: #F2B134;');
    expect(tokens).toContain('--matou-secondary-strong: #F2B134;');
    // …but the saturated gold lands as a pale translucent wash on the
    // secondary/muted backgrounds and the selected-nav accent, in both themes.
    expect(tokens).toContain('--matou-secondary: color-mix(in srgb, #F2B134 12%, transparent);');
    expect(tokens).toContain('--matou-muted: color-mix(in srgb, #F2B134 12%, transparent);');
    expect(tokens).toContain('--matou-sidebar-accent: color-mix(in srgb, #F2B134 16%, transparent);');
    expect(tokens).toMatch(/\.dark\s*\{[\s\S]*--matou-sidebar-accent: color-mix\(in srgb, #F2B134 16%, transparent\);/);
    // Foreground on the wash stays the primary colour for contrast.
    expect(tokens).toContain('--matou-secondary-foreground: #0A5C6B;');
  });
  it('android application id is a valid package name: hyphens → underscores, digit-leading segment prefixed', async () => {
    await applyKit(await kitDir({ slug: '4winds-trust', brand: { name: '4 Winds', slug: '4winds-trust', primaryColour: '#0A5C6B', secondaryColour: '#F2B134', contactEmail: 'k@x.nz' } }), root, { icons: false });
    const build = JSON.parse(await readFile(join(root, 'kit.build.json'), 'utf8'));
    expect(build).toMatchObject({ appId: 'org.matou.coa.4winds-trust', androidApplicationId: 'org.matou.coa._4winds_trust', urlScheme: 'org.matou.coa.4winds-trust' });
    const gradle = await readFile(join(root, 'src-capacitor/android/app/build.gradle'), 'utf8');
    expect(gradle).toContain('applicationId "org.matou.coa._4winds_trust"');
  });
  it('rejects a kit with a bad slug or missing brand', async () => {
    await expect(applyKit(await kitDir({ slug: 'Bad Slug' }), root, { icons: false })).rejects.toThrow(/slug/);
  });
  it('escapes XML in the app name', async () => {
    await applyKit(await kitDir({ slug: 'a-b', brand: { name: 'Tui & Kea', slug: 'a-b', primaryColour: '#000000', secondaryColour: '#ffffff', contactEmail: 'k@x.nz' } }), root, { icons: false });
    expect(await readFile(join(root, 'src-capacitor/android/app/src/main/res/values/strings.xml'), 'utf8')).toContain('Tui &amp; Kea');
  });
});

describe('kit secondary wash (#337)', () => {
  it('treats pale near-white / low-chroma tints as soft (kept solid)', () => {
    expect(isSoftTint('#E8F4F8')).toBe(true); // stock secondary
    expect(isSoftTint('#ffffff')).toBe(true);
    expect(isSoftTint('#cfe8d0')).toBe(true); // pale green pastel
  });
  it('treats saturated or darker brand colours as loud (washed)', () => {
    expect(isSoftTint('#F2B134')).toBe(false); // gold
    expect(isSoftTint('#ffee00')).toBe(false); // saturated but light yellow
    expect(isSoftTint('#1E5F74')).toBe(false); // dark teal
    expect(isSoftTint('#7a90a0')).toBe(false); // low-chroma but too dark
  });
  it('keeps the stock look: a soft tint maps to itself, no wash', () => {
    const scss = tokensScss({ brand: { primaryColour: '#1E5F74', secondaryColour: '#E8F4F8' } });
    expect(scss).toContain('--matou-secondary: #E8F4F8;');
    expect(scss).not.toContain('color-mix');
  });
  it('washes a loud secondary and preserves the full-strength value', () => {
    const scss = tokensScss({ brand: { primaryColour: '#0A5C6B', secondaryColour: '#F2B134' } });
    expect(scss).toContain('$kit-secondary: #F2B134;');
    expect(scss).toContain('--matou-secondary-strong: #F2B134;');
    expect(scss).toContain('--matou-secondary: color-mix(in srgb, #F2B134 12%, transparent);');
    expect(scss).toContain('--matou-sidebar-accent: color-mix(in srgb, #F2B134 16%, transparent);');
  });
});
