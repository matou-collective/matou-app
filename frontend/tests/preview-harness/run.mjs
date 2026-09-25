#!/usr/bin/env node
/* global process */
// Start the preview harness: apply a brand kit, then run `quasar dev` with the
// fake backend and fake KERIA switched on. On exit the stock kit (../coa-kit)
// is re-applied, so the generated files go back to what git has.
//
//   npm run harness                      # kit "tui", http://127.0.0.1:9100
//   npm run harness -- --kit pale
//   npm run harness -- --kit ../coa-kit  # any kit directory works
//   npm run harness -- --kits-dir ~/coa/communities   # more kits in the picker
//   npm run harness -- --port 9200
//
// Brand and features are baked in at build time, so the picker's kit switch
// comes back here: this script stays the parent, and on a switch it stops the
// dev server, applies the new kit and starts the dev server again.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const flags = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const port = flag('port', '9100');

// The picker's catalogue: id -> kit directory. The harness's own kits first,
// then every --kits-dir (a folder of kit folders, e.g. coa's communities/).
const catalogue = {};
for (const dir of [join(HERE, 'kits'), ...flags('kits-dir').map((d) => resolve(process.cwd(), d))]) {
  if (!existsSync(dir)) {
    console.warn(`harness: no kits directory ${dir}`);
    continue;
  }
  for (const entry of readdirSync(dir).sort()) {
    const kitDir = join(dir, entry);
    if (!(entry in catalogue) && existsSync(join(kitDir, 'kit.json'))) catalogue[entry] = kitDir;
  }
}

// --kit is a catalogue id or any kit directory (added to the catalogue under its folder name).
const kitArg = flag('kit', 'tui');
let current = kitArg in catalogue ? kitArg : basename(resolve(process.cwd(), kitArg));
if (!(kitArg in catalogue)) {
  const dir = resolve(process.cwd(), kitArg);
  if (!existsSync(join(dir, 'kit.json'))) {
    console.error(`harness: no kit "${kitArg}". Kits: ${Object.keys(catalogue).join(', ')}`);
    process.exit(1);
  }
  catalogue[current] = dir;
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

if (!(await applyKit(catalogue[current]))) process.exit(1);

// 127.0.0.1, not localhost: the page is moved there too (see backendPlugin.ts),
// so the browser-platform prefix and the desktop platform root share an origin.
const fake = `http://127.0.0.1:${port}/__fake`;

let dev = null;
let switching = null; // the kit id being switched to, while the dev server is down
let stopping = false;

function startDev(openBrowser) {
  // node + the quasar CLI script (not npx or the .bin shim): signals reach the
  // dev server, nothing is orphaned on the port, and the IPC channel the
  // backend plugin asks for kit switches on is guaranteed to be node's.
  dev = spawn(process.execPath, [join(FRONTEND, 'node_modules/@quasar/app-vite/bin/quasar.js'), 'dev', '-p', port], {
    cwd: FRONTEND,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      MATOU_HARNESS: '1',
      MATOU_HARNESS_OPEN: openBrowser ? '1' : '0',
      MATOU_HARNESS_KITS: JSON.stringify(catalogue),
      MATOU_HARNESS_KIT: current,
      VITE_ENV: 'dev',
      VITE_BACKEND_URL: fake,
      VITE_DEV_CONFIG_URL: fake,
    },
  });
  dev.on('message', (msg) => {
    if (msg?.type !== 'switch-kit' || !(msg.id in catalogue) || msg.id === current || switching) return;
    switching = msg.id;
    console.log(`\nharness: switching kit ${current} → ${msg.id}…`);
    dev.kill('SIGTERM');
  });
  dev.on('exit', async (code) => {
    if (switching && !stopping) {
      const next = switching;
      if (await applyKit(catalogue[next])) current = next;
      else console.error(`harness: could not apply ${next}; staying on ${current}`);
      switching = null;
      startDev(false);
      return;
    }
    console.log('\nharness: restoring the stock kit (../coa-kit)…');
    await applyKit(join(FRONTEND, '..', 'coa-kit'));
    process.exit(code ?? 0);
  });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopping = true;
    dev?.kill(sig);
  });
}

startDev(true);
