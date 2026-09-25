/**
 * The preview harness's boot file. `quasar.config.ts` adds it ahead of the
 * `keri` boot only when MATOU_HARNESS=1 (see `run.mjs`), so nothing here is
 * reachable from a real build.
 *
 * It picks the scenario (`?scenario=<id>`, remembered across reloads), seeds
 * the wallet and storage that scenario starts from, swaps the KERIA client for
 * the fake wallet, and draws the scenario picker. The real `keri` boot then
 * runs unchanged against the fake backend the dev server answers on /__fake.
 * The platform (desktop/browser) is chosen earlier, by the script the backend
 * plugin injects into index.html — Electron's bridge must exist before any
 * app module loads.
 */
import { boot } from 'quasar/wrappers';
import { applyTheme, persistTheme } from 'src/boot/theme';
import { installFakeKeria, passcodeOf, saveWallet, seedWallet } from './fakeKeria';
import {
  DEFAULT_PLATFORM,
  FAKE_PREFIX,
  PEOPLE,
  PLATFORM_KEY,
  PLATFORMS,
  SCENARIO_COOKIE,
  SCENARIOS,
  scenarioById,
  type Scenario,
} from './scenarios';

const CHOSEN_KEY = 'matou-harness:scenario';

/** Wipe everything a previous scenario (or a real session) left behind. */
function resetStorage(scenario: Scenario): void {
  const keep = ['matou:theme', PLATFORM_KEY].map((k) => [k, localStorage.getItem(k)] as const);
  localStorage.clear();
  for (const [k, v] of keep) if (v) localStorage.setItem(k, v);
  saveWallet(seedWallet(scenario));
  if (scenario.signedInAs) {
    localStorage.setItem('matou_passcode', passcodeOf(scenario.signedInAs));
    localStorage.setItem('matou_mnemonic', PEOPLE[scenario.signedInAs].mnemonic);
  }
  localStorage.setItem(CHOSEN_KEY, scenario.id);
}

async function chooseScenario(): Promise<Scenario> {
  const params = new URLSearchParams(window.location.search);
  const asked = params.get('scenario');
  const remembered = localStorage.getItem(CHOSEN_KEY);
  const scenario = scenarioById(asked ?? remembered);
  if (scenario.id !== remembered || params.has('reset')) {
    resetStorage(scenario);
    // The fake backend keeps per-scenario state (a registration just sent, a
    // message just posted); start this scenario from its seed again.
    await fetch(`${FAKE_PREFIX}/__reset?scenario=${scenario.id}`, { method: 'POST' });
    if (params.has('reset')) {
      params.delete('reset');
      const query = params.toString();
      history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }
  }
  document.cookie = `${SCENARIO_COOKIE}=${scenario.id}; path=/; SameSite=Lax`;
  return scenario;
}

function go(id: string, platform = currentPlatform()): void {
  // Land on the app's first screen; the router guard sends a signed-in person on.
  window.location.href = `${window.location.pathname}?scenario=${id}&platform=${platform}&reset#/`;
}

const isDark = () => document.documentElement.classList.contains('dark');

function currentPlatform(): string {
  return localStorage.getItem(PLATFORM_KEY) ?? DEFAULT_PLATFORM;
}

interface KitCatalogue {
  current: string;
  kits: Array<{ id: string; name: string; primary: string; secondary: string }>;
}

async function loadKits(): Promise<KitCatalogue> {
  try {
    const res = await fetch(`${FAKE_PREFIX}/__kits`);
    if (res.ok) return (await res.json()) as KitCatalogue;
  } catch {
    /* no kit switching then */
  }
  return { current: '', kits: [] };
}

const escape = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Ask run.mjs for another kit, then wait out the dev-server restart: poll
 * until the server answers with the new kit applied, and reload in place.
 */
async function switchKit(id: string, name: string, overlay: HTMLElement): Promise<void> {
  overlay.querySelector('.msg')!.textContent = `Switching to ${name}…`;
  overlay.hidden = false;
  const asked = await fetch(`${FAKE_PREFIX}/__kit?id=${encodeURIComponent(id)}`, { method: 'POST' }).catch(() => null);
  if (!asked || asked.status !== 202) {
    overlay.querySelector('.msg')!.textContent = 'Kit switching needs the harness started with npm run harness.';
    return;
  }
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const kits = await fetch(`${FAKE_PREFIX}/__kits`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<KitCatalogue>) : null))
      .catch(() => null);
    if (kits?.current === id) break;
    if (Date.now() - started > 120_000) {
      overlay.querySelector('.msg')!.textContent = 'The dev server did not come back — check the harness terminal.';
      return;
    }
  }
  window.location.reload();
}

function drawPicker(current: Scenario, kits: KitCatalogue): void {
  const host = document.createElement('div');
  host.setAttribute('data-testid', 'harness-picker');
  const root = host.attachShadow({ mode: 'open' });
  const who = current.signedInAs ? PEOPLE[current.signedInAs].name : 'nobody yet';
  const active = kits.kits.find((k) => k.id === kits.current);
  const phrases = (Object.values(PEOPLE)).map((p) => `${p.name}: ${p.mnemonic}`).join('\n');
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .pill {
        position: fixed; left: 12px; bottom: 12px; z-index: 2147483647;
        display: flex; gap: 6px; align-items: center;
        padding: 6px 8px; border-radius: 999px;
        font: 12px/1.2 system-ui, sans-serif; color: #f5f5f5;
        background: rgba(20, 20, 20, 0.82); box-shadow: 0 4px 16px rgba(0,0,0,.25);
        backdrop-filter: blur(6px);
      }
      .pill.min .rest { display: none; }
      b { font-weight: 600; letter-spacing: .02em; cursor: pointer; }
      select, button {
        font: inherit; color: inherit; background: rgba(255,255,255,.12);
        border: 1px solid rgba(255,255,255,.2); border-radius: 999px; padding: 3px 8px; cursor: pointer;
      }
      select option { color: #111; }
      .who { opacity: .7; }
      .swatch { display: inline-flex; border-radius: 999px; overflow: hidden; border: 1px solid rgba(255,255,255,.35); }
      .swatch i { width: 10px; height: 14px; display: block; }
      .overlay {
        position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
        background: rgba(10, 10, 10, .72); color: #fff; font: 15px/1.4 system-ui, sans-serif;
      }
      .overlay[hidden] { display: none; }
    </style>
    <div class="pill" title="${current.blurb}\n\nRecover identity with any of these phrases:\n${phrases}">
      <b id="toggle">HARNESS</b>
      <span class="rest">
        ${kits.kits.length ? `<span class="swatch" title="${escape(active?.name ?? '')}"><i style="background:${active?.primary ?? '#888'}"></i><i style="background:${active?.secondary ?? '#ccc'}"></i></span>
        <select id="kit" aria-label="Brand kit">
          ${kits.kits.map((k) => `<option value="${escape(k.id)}" ${k.id === kits.current ? 'selected' : ''}>${escape(k.name)} (${escape(k.id)})</option>`).join('')}
        </select>` : ''}
        <select id="scenario" aria-label="Scenario">
          ${SCENARIOS.map((s) => `<option value="${s.id}" ${s.id === current.id ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select>
        <select id="platform" aria-label="Platform">
          ${PLATFORMS.map((p) => `<option value="${p.id}" ${p.id === currentPlatform() ? 'selected' : ''}>${p.label}</option>`).join('')}
        </select>
        <button id="theme" title="Night mode on/off (the app's own theme switch, remembered like it)">${isDark() ? '☀ Day' : '☾ Night'}</button>
        <button id="restart" title="Start this scenario again from its first screen">Restart</button>
        <span class="who">as ${who}</span>
      </span>
    </div>
    <div class="overlay" hidden><span class="msg"></span></div>`;
  const pill = root.querySelector('.pill')!;
  root.getElementById('toggle')!.addEventListener('click', () => pill.classList.toggle('min'));
  const overlay = root.querySelector<HTMLElement>('.overlay')!;
  root.getElementById('kit')?.addEventListener('change', (e) => {
    const id = (e.target as HTMLSelectElement).value;
    void switchKit(id, kits.kits.find((k) => k.id === id)?.name ?? id, overlay);
  });
  root.getElementById('scenario')!.addEventListener('change', (e) => go((e.target as HTMLSelectElement).value));
  root.getElementById('platform')!.addEventListener('change', (e) => go(current.id, (e.target as HTMLSelectElement).value));
  const theme = root.getElementById('theme')!;
  theme.addEventListener('click', () => {
    const dark = !isDark();
    applyTheme(dark);
    persistTheme(dark ? 'dark' : 'light');
    theme.textContent = dark ? '☀ Day' : '☾ Night';
  });
  root.getElementById('restart')!.addEventListener('click', () => go(current.id));
  document.body.appendChild(host);
}

export default boot(async () => {
  const scenario = await chooseScenario();
  installFakeKeria();
  drawPicker(scenario, await loadKits());
  console.info(`[harness] scenario "${scenario.id}" — ${scenario.blurb}`);
});
