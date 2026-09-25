#!/usr/bin/env node
/* global process */
// Start the preview harness: apply a harness brand kit, then run `quasar dev`
// with the fake backend and fake KERIA switched on. On exit the stock kit
// (../coa-kit) is re-applied, so the generated files go back to what git has.
//
//   npm run harness                      # kit "tui", port 9100
//   npm run harness -- --kit pale
//   npm run harness -- --kit ../coa-kit  # any kit directory works
//   npm run harness -- --port 9200
//
// Brand and features are baked in at build time, so a different kit means
// stopping the harness and starting it again with another --kit.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..', '..');
const KITS = join(HERE, 'kits');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const kitArg = flag('kit', 'tui');
const port = flag('port', '9100');
const kitDir = existsSync(join(KITS, kitArg)) ? join(KITS, kitArg) : resolve(process.cwd(), kitArg);
if (!existsSync(join(kitDir, 'kit.json'))) {
  console.error(`harness: no kit "${kitArg}". Harness kits: ${readdirSync(KITS).join(', ')}`);
  process.exit(1);
}

// The generated sources, without the ~40 platform icons (launcher, splash,
// electron) a browser never shows...
const applySources = (dir) =>
  spawnSync(process.execPath, [join(FRONTEND, 'scripts/kit/apply-kit.mjs'), dir, '--no-icons'], {
    cwd: FRONTEND,
    stdio: 'inherit',
  }).status === 0;

// ...plus the two the browser does show: the in-app logo and the favicons.
// Rendered into a scratch root and copied over (rendering is deterministic, so
// the stock kit's restore reproduces the committed files byte for byte).
async function applyBrowserIcons(dir) {
  const kit = JSON.parse(readFileSync(join(dir, 'kit.json'), 'utf8'));
  const scratch = mkdtempSync(join(tmpdir(), 'matou-harness-icons-'));
  try {
    const { renderIcons } = await import(join(FRONTEND, 'scripts/kit/icons.mjs'));
    await renderIcons({ logo: join(dir, kit.logoFile), primary: kit.brand.primaryColour, root: scratch });
    cpSync(join(scratch, 'src/assets/kit/logo.png'), join(FRONTEND, 'src/assets/kit/logo.png'));
    cpSync(join(scratch, 'public/icons'), join(FRONTEND, 'public/icons'), { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const applyKit = async (dir) => {
  if (!applySources(dir)) return false;
  await applyBrowserIcons(dir);
  return true;
};

if (!(await applyKit(kitDir))) process.exit(1);

let restored = false;
const restore = async () => {
  if (restored) return;
  restored = true;
  console.log('\nharness: restoring the stock kit (../coa-kit)…');
  await applyKit(join(FRONTEND, '..', 'coa-kit'));
};

const fake = `http://localhost:${port}/__fake`;
// The quasar binary itself (not npx), so a signal reaches the dev server and
// nothing is orphaned on the port.
const dev = spawn(join(FRONTEND, 'node_modules/.bin/quasar'), ['dev', '-p', port], {
  cwd: FRONTEND,
  stdio: 'inherit',
  env: {
    ...process.env,
    MATOU_HARNESS: '1',
    VITE_ENV: 'dev',
    VITE_BACKEND_URL: fake,
    VITE_DEV_CONFIG_URL: fake,
  },
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => dev.kill(sig));
}
dev.on('exit', async (code) => {
  await restore();
  process.exit(code ?? 0);
});
