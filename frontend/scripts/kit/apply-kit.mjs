#!/usr/bin/env node
// Turn coa-kit/ (kit.json + logo) into the generated artefacts the build and
// the app read. See Matou/coa ADR 0004. Usage:
//   node scripts/kit/apply-kit.mjs [kitDir=../coa-kit] [--root <frontend dir>] [--no-icons]
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function assert(cond, msg) { if (!cond) throw new Error(`apply-kit: ${msg}`); }

export function validateKit(kit) {
  assert(kit && kit.version === 1, 'kit.version must be 1');
  assert(typeof kit.slug === 'string' && SLUG_RE.test(kit.slug), `invalid slug ${JSON.stringify(kit.slug)}`);
  assert(kit.brand && typeof kit.brand.name === 'string' && kit.brand.name.trim(), 'brand.name required');
  assert(HEX_RE.test(kit.brand.primaryColour) && HEX_RE.test(kit.brand.secondaryColour), 'brand colours must be #rrggbb');
  assert(kit.logoFile === 'logo.svg' || kit.logoFile === 'logo.png', 'logoFile must be logo.svg or logo.png');
  assert(kit.onboarding && Array.isArray(kit.onboarding.infoPages) && kit.onboarding.infoPages.length <= 3, 'onboarding.infoPages ≤ 3');
  assert(kit.onboarding.profile && Array.isArray(kit.onboarding.profile.interestOptions), 'onboarding.profile.interestOptions required');
  assert(kit.onboarding.approval && typeof kit.onboarding.approval.mode === 'string', 'onboarding.approval.mode required');
  return kit;
}

const hex = (n) => n.toString(16).padStart(2, '0');
export function mixWithWhite(colour, weight) {
  const r = parseInt(colour.slice(1, 3), 16), g = parseInt(colour.slice(3, 5), 16), b = parseInt(colour.slice(5, 7), 16);
  const mix = (c) => Math.round(c * weight + 255 * (1 - weight));
  return `#${hex(mix(r))}${hex(mix(g))}${hex(mix(b))}`;
}

// A "soft tint" is a colour that is already near-white / a pale pastel (like
// stock Matou's hand-picked secondary #E8F4F8): every channel is light AND the
// colour is low-chroma. Such a value is left solid so the stock look — and any
// kit that hand-picks an already-pale secondary — is unchanged. A saturated or
// darker brand colour (e.g. gold #F2B134) is NOT a soft tint and is rendered as
// a very light translucent wash instead of a loud solid background. See #337.
export function isSoftTint(colour) {
  const r = parseInt(colour.slice(1, 3), 16), g = parseInt(colour.slice(3, 5), 16), b = parseInt(colour.slice(5, 7), 16);
  const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  return Math.min(r, g, b) >= 200 && chroma <= 0.2;
}

// A translucent wash of a colour — faint enough to sit over both light and dark
// surfaces (the transparency does the theme adaptation for free). `pct` is the
// colour's opacity percentage; the remainder is transparent.
const wash = (colour, pct) => `color-mix(in srgb, ${colour} ${pct}%, transparent)`;
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Android package-name segments must be Java identifiers: no '-', no leading digit.
// (Electron appIds and URL schemes keep the hyphenated slug — '_' is illegal in a scheme.)
export function androidSegment(slug) {
  const s = slug.replace(/-/g, '_');
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

export function buildInfo(kit) {
  const isMatou = kit.slug === 'matou';
  return {
    appId: isMatou ? 'org.matou.app' : `org.matou.coa.${kit.slug}`,
    // Display name, but ALSO the packaging identity: electron-builder names
    // the Windows exe, the mac .app bundle, the DMG volume AND Electron's
    // userData directory (where the KERI identity + backend data live) after
    // productName. A rename orphans every existing install's data dir, so
    // fold diacritics: the brand keeps its macrons everywhere users read
    // (KIT.brand.name, Android launcher label, store listings); the OS-facing
    // name stays ASCII. Learned on v0.6.1: "Mātou.exe" broke all three
    // desktop builds' smoke tests and would have stranded testers' data.
    productName: kit.brand.name.normalize('NFD').replace(/\p{Diacritic}/gu, ''),
    artifactBase: isMatou ? 'matou' : kit.slug,
    executableName: isMatou ? 'matou' : kit.slug,
    androidApplicationId: isMatou ? 'nz.matou.app' : `org.matou.coa.${androidSegment(kit.slug)}`,
    urlScheme: isMatou ? 'nz.matou.app' : `org.matou.coa.${kit.slug}`,
    publish: isMatou ? [{ provider: 'github', owner: 'matou-collective', repo: 'matou-app', releaseType: 'draft' }] : null,
    updates: isMatou,
    primaryColour: kit.brand.primaryColour,
    backgroundColour: kit.brand.primaryColour,
  };
}

export function tokensScss(kit) {
  const p = kit.brand.primaryColour, s = kit.brand.secondaryColour, a = mixWithWhite(p, 0.7);
  const soft = isSoftTint(s);
  // Secondary/muted backgrounds and the selected-nav wash. A soft tint stays
  // solid (stock #E8F4F8 unchanged); a saturated colour becomes a pale wash.
  // The full-strength colour stays available as $kit-secondary and the
  // --matou-secondary-strong token for the few places that want it.
  const secondary = soft ? s : wash(s, 12);
  const sidebarAccent = soft ? s : wash(s, 16);
  // Dark theme: the translucent wash renders over dark surfaces too, so it is
  // reused as-is; a soft tint keeps the Matou dark values so stock dark mode is
  // unchanged (these override the .dark block, which no longer hardcodes them).
  const secondaryDark = soft ? '#1e3340' : wash(s, 12);
  const sidebarAccentDark = soft ? '#1e3340' : wash(s, 16);
  return `// GENERATED by scripts/kit/apply-kit.mjs from coa-kit/kit.json — do not edit.
$kit-primary: ${p};
$kit-secondary: ${s};
$kit-accent: ${a};
$kit-primary-foreground: #ffffff;

:root {
  --matou-primary: ${p};
  --matou-secondary: ${secondary};
  --matou-secondary-strong: ${s};
  --matou-secondary-foreground: ${p};
  --matou-muted: ${secondary};
  --matou-accent: ${a};
  --matou-sidebar-accent: ${sidebarAccent};
}

.dark {
  --matou-secondary: ${secondaryDark};
  --matou-muted: ${secondaryDark};
  --matou-sidebar-accent: ${sidebarAccentDark};
}
`;
}

export function kitTs(kit, build) {
  return `// GENERATED by scripts/kit/apply-kit.mjs from coa-kit/kit.json — do not edit.
import type { Kit, KitBuild } from 'src/kit/types';

export const KIT: Kit = ${JSON.stringify(kit, null, 2)};

export const KIT_BUILD: KitBuild = ${JSON.stringify(build, null, 2)};
`;
}

async function patchAndroid(root, kit, build) {
  const cap = join(root, 'src-capacitor/capacitor.config.json');
  const capJson = JSON.parse(await readFile(cap, 'utf8'));
  capJson.appId = build.androidApplicationId;
  capJson.appName = kit.brand.name;
  await writeFile(cap, JSON.stringify(capJson, null, 2) + '\n');

  const strings = join(root, 'src-capacitor/android/app/src/main/res/values/strings.xml');
  let xmlText = await readFile(strings, 'utf8');
  const set = (name, value) => { xmlText = xmlText.replace(new RegExp(`<string name="${name}">[^<]*</string>`), `<string name="${name}">${xml(value)}</string>`); };
  set('app_name', kit.brand.name); set('title_activity_main', kit.brand.name);
  set('package_name', build.androidApplicationId); set('custom_url_scheme', build.urlScheme);
  await writeFile(strings, xmlText);

  const gradle = join(root, 'src-capacitor/android/app/build.gradle');
  const g = await readFile(gradle, 'utf8');
  assert(/applicationId "[^"]+"/.test(g), 'build.gradle has no applicationId line');
  await writeFile(gradle, g.replace(/applicationId "[^"]+"/, `applicationId "${build.androidApplicationId}"`));
  return [cap, strings, gradle];
}

export async function applyKit(kitDir, root = FRONTEND, opts = { icons: true }) {
  const kit = validateKit(JSON.parse(await readFile(join(kitDir, 'kit.json'), 'utf8')));
  const logo = join(kitDir, kit.logoFile);
  assert(existsSync(logo), `logo missing: ${logo}`);
  const build = buildInfo(kit);
  const written = [];
  const out = async (rel, text) => { const p = join(root, rel); await mkdir(dirname(p), { recursive: true }); await writeFile(p, text); written.push(p); };

  await out('kit.build.json', JSON.stringify(build, null, 2) + '\n');
  await out('src/generated/kit.ts', kitTs(kit, build));
  await out('src/css/kit-tokens.scss', tokensScss(kit));
  written.push(...(await patchAndroid(root, kit, build)));

  if (opts.icons !== false) {
    const { renderIcons } = await import('./icons.mjs');
    written.push(...(await renderIcons({ logo, primary: kit.brand.primaryColour, root })));
  }
  return { written };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? resolve(args[rootIdx + 1]) : FRONTEND;
  const icons = !args.includes('--no-icons');
  const kitDir = resolve(args.find((a, i) => !a.startsWith('--') && (rootIdx < 0 || i !== rootIdx + 1)) ?? join(FRONTEND, '..', 'coa-kit'));
  applyKit(kitDir, root, { icons }).then((r) => { console.log(`apply-kit: wrote ${r.written.length} files from ${kitDir}`); }).catch((e) => { console.error(e.message); process.exit(1); });
}
