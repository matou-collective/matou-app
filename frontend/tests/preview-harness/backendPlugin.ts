/**
 * The fake backend + config server, as a Vite dev-server middleware mounted on
 * /__fake. `run.mjs` points VITE_BACKEND_URL and VITE_DEV_CONFIG_URL here, so
 * every transport the app uses — fetch, the /events EventSource and <img src>
 * file URLs — reaches it same-origin, with the scenario cookie attached.
 *
 * On the `desktop` platform the app resolves the backend the Electron way,
 * `http://127.0.0.1:<port>` with no prefix, so the same routes also answer at
 * the root (`/api/*`, `/health`); `run.mjs` serves the harness on 127.0.0.1 so
 * both forms are same-origin.
 *
 * Unmodelled routes answer the way an empty backend would (GET → 404, writes →
 * `{ success: true }`) and are logged once to the dev-server console, so a new
 * screen shows its empty state rather than hanging.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { avatarSvg, buildWorld, nextId, type World } from './backendWorld';
import { dashboardRoutes } from './backendRoutes';
import {
  DEFAULT_PLATFORM,
  FAKE_PREFIX,
  LINKED_PERSON,
  ORG,
  PEOPLE,
  PLATFORM_KEY,
  SCENARIO_COOKIE,
  scenarioById,
  type PersonId,
} from './scenarios';

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** The AID the request is made as (from the harness session token). */
  me: string | null;
  world: World;
}
export type Reply = { status?: number; json?: unknown; raw?: { type: string; body: string | Buffer } } | undefined;
export type Route = [method: string, pattern: RegExp, handler: (req: Req, m: RegExpMatchArray) => Reply];

const json = (value: unknown, status = 200): Reply => ({ status, json: value });

/** The kit the dev server was started with — the community's name comes from it. */
function kitName(root: string): string {
  try {
    const src = readFileSync(join(root, 'src/generated/kit.ts'), 'utf8');
    const body = src.slice(src.indexOf('export const KIT'));
    const kit = JSON.parse(body.slice(body.indexOf('{'), body.indexOf('\n};') + 2)) as { brand: { name: string } };
    return kit.brand.name;
  } catch {
    return 'Harness Community';
  }
}

function orgConfig(world: World) {
  const steward = PEOPLE.aroha;
  return {
    organization: { aid: ORG.aid, name: world.communityName, oobi: `http://localhost:3902/oobi/${ORG.aid}` },
    admins: [{ aid: steward.aid, name: steward.name, oobi: `http://localhost:3902/oobi/${steward.aid}` }],
    registry: { id: ORG.registry, name: world.communityName },
    communitySpaceId: ORG.communitySpaceId,
    readOnlySpaceId: ORG.readOnlySpaceId,
    adminSpaceId: ORG.adminSpaceId,
    generated: '2026-09-01T09:00:00.000Z',
  };
}

const space = (spaceId: string, spaceName: string) => ({
  spaceId,
  spaceName,
  createdAt: '2026-09-01T09:00:00.000Z',
  keysAvailable: true,
  spaceAccess: 'ok',
});

const coreRoutes: Route[] = [
  // --- config server
  ['GET', /^\/api\/client-config$/, () =>
    json({
      version: '1.0',
      mode: 'dev',
      keri: { admin_url: 'http://localhost:3901', boot_url: 'http://localhost:3903', cesr_url: 'http://localhost:3902' },
      config_server_url: FAKE_PREFIX,
      witnesses: { urls: [], aids: {}, oobis: [] },
      anysync: { id: 'harness', networkId: 'harness', nodes: [] },
    })],
  ['GET', /^\/api\/config$/, ({ world }) => json(orgConfig(world))],
  ['GET', /^\/api\/health$/, () => json({ status: 'ok' })],
  ['GET', /^\/health$/, () => json({ status: 'ok' })],
  // --- org
  ['GET', /^\/api\/v1\/org\/config$/, ({ world }) => json(orgConfig(world))],
  ['GET', /^\/api\/v1\/org\/health$/, () => json({ status: 'ok', configured: true })],
  ['GET', /^\/api\/v1\/org$/, ({ world }) => json({ orgAid: ORG.aid, name: world.communityName, description: '' })],
  // --- auth: the session token names the AID, so later calls know who "me" is
  ['POST', /^\/api\/v1\/auth\/challenge$/, () => json({ challenge: 'harness-challenge', expiresAt: '2099-01-01T00:00:00Z' })],
  ['POST', /^\/api\/v1\/auth\/login$/, ({ body }) =>
    json({ token: `harness.${(body as { aid?: string })?.aid ?? ''}`, expiresAt: '2099-01-01T00:00:00Z' })],
  // --- backend identity
  ['GET', /^\/api\/v1\/identity$/, ({ world }) =>
    json(world.identity
      ? { configured: true, aid: world.identity.aid, peerId: 'harness-peer', orgAid: ORG.aid,
          communitySpaceId: ORG.communitySpaceId, communityReadOnlySpaceId: ORG.readOnlySpaceId,
          privateSpaceId: `private-${world.identity.aid.slice(0, 12)}` }
      : { configured: false })],
  ['POST', /^\/api\/v1\/identity\/set$/, ({ world, body }) => {
    const aid = (body as { aid?: string })?.aid ?? '';
    world.identity = { aid, configured: true };
    return json({ success: true, peerId: 'harness-peer', privateSpaceId: `private-${aid.slice(0, 12)}` });
  }],
  ['DELETE', /^\/api\/v1\/identity$/, ({ world }) => { world.identity = null; return json({ success: true }); }],
  // --- spaces: access follows membership in the world
  ['GET', /^\/api\/v1\/spaces\/user$/, ({ world, query }) => {
    const aid = query.get('aid') ?? '';
    if (!world.memberAids.has(aid)) return json({ privateSpace: space(`private-${aid.slice(0, 12)}`, 'Private') });
    return json({
      privateSpace: space(`private-${aid.slice(0, 12)}`, 'Private'),
      communitySpace: space(ORG.communitySpaceId, 'Community'),
      communityReadOnlySpace: space(ORG.readOnlySpaceId, 'Community (read-only)'),
      ...(world.scenario.steward ? { adminSpace: space(ORG.adminSpaceId, 'Admin') } : {}),
    });
  }],
  ['GET', /^\/api\/v1\/spaces\/community\/verify-access$/, ({ world, query }) => {
    const ok = world.memberAids.has(query.get('aid') ?? '');
    return json({ hasAccess: ok, spaceId: ok ? ORG.communitySpaceId : undefined, canRead: ok, canWrite: ok });
  }],
  ['GET', /^\/api\/v1\/spaces\/sync-status$/, () => {
    const item = { spaceId: ORG.communitySpaceId, hasObjectTree: true, objectCount: 42, profileCount: 3 };
    return json({ community: item, readOnly: { ...item, spaceId: ORG.readOnlySpaceId }, ready: true });
  }],
  // --- type definitions: dumped from the Go registry (fixtures/types.json)
  ['GET', /^\/api\/v1\/types$/, () => json({ types: TYPES, count: TYPES.length })],
  ['GET', /^\/api\/v1\/types\/([^/]+)$/, (_r, m) => {
    const def = TYPES.find((t) => t.name === decodeURIComponent(m[1]!));
    return def ? json(def) : json({ error: 'not found' }, 404);
  }],
  // --- profiles
  ['GET', /^\/api\/v1\/profiles\/me$/, ({ world, me }) => {
    const mine: Record<string, unknown[]> = {};
    for (const [type, list] of Object.entries(world.profiles)) {
      mine[type] = list.filter((p) => p.ownerKey === me || p.data.aid === me || p.data.userAID === me);
    }
    return json(mine);
  }],
  ['GET', /^\/api\/v1\/profiles\/([^/]+)$/, ({ world, query }, m) => {
    let list = world.profiles[decodeURIComponent(m[1]!)] ?? [];
    for (const [k, v] of query) list = list.filter((p) => String(p.data[k] ?? '') === v);
    return json({ profiles: list, count: list.length, type: m[1] });
  }],
  ['GET', /^\/api\/v1\/profiles\/([^/]+)\/([^/]+)$/, ({ world }, m) => {
    const found = (world.profiles[decodeURIComponent(m[1]!)] ?? []).find((p) => p.id === decodeURIComponent(m[2]!));
    return found ? json(found) : json({ error: 'not found' }, 404);
  }],
  ['POST', /^\/api\/v1\/profiles$/, ({ world, body, me }) => {
    const b = body as { type: string; id?: string; data: Record<string, unknown> };
    const list = (world.profiles[b.type] ??= []);
    const id = b.id ?? `${b.type}-${me ?? nextId('anon')}`;
    const existing = list.find((p) => p.id === id);
    const next = { id, type: b.type, ownerKey: me ?? '', data: b.data, timestamp: Date.now(), version: (existing?.version ?? 0) + 1 };
    if (existing) Object.assign(existing, next);
    else list.push(next);
    return json({ success: true, objectId: id, headId: `head-${id}` });
  }],
  // --- files: uploads kept in memory; harness avatars drawn on demand
  ['POST', /^\/api\/v1\/files\/upload$/, ({ world, body }) => {
    const ref = nextId('file');
    const upload = body as { type: string; body: Buffer } | undefined;
    if (upload?.body) world.files.set(ref, upload);
    return json({ fileRef: ref });
  }],
  ['GET', /^\/api\/v1\/files\/([^/]+)$/, ({ world }, m) => {
    const ref = decodeURIComponent(m[1]!);
    const person = ref.startsWith('harness-avatar-') ? (ref.slice('harness-avatar-'.length) as PersonId) : null;
    if (person && person in PEOPLE) return { raw: { type: 'image/svg+xml', body: avatarSvg(person) } };
    const file = world.files.get(ref);
    return file ? { raw: file } : json({ error: 'not found' }, 404);
  }],
  // --- registration side-effects
  ['POST', /^\/api\/v1\/notifications\/registration-(submitted|approved)$/, () => json({ success: true, messageId: 'harness' })],
  ['POST', /^\/api\/v1\/(invites|booking)\/send-email$/, () => json({ success: true, messageId: 'harness' })],
  // --- linked-device sign-in, desktop side (#466): a scripted phone scans the
  // QR after a few seconds, shows its code, then hands over LINKED_PERSON.
  ['POST', /^\/api\/v1\/pairing\/sessions$/, ({ world }) => {
    const sessionId = nextId('pair');
    pairings(world).set(sessionId, { createdAt: Date.now(), cancelled: false });
    return json({
      sessionId,
      qrPayload: `matou://pair?session=${sessionId}&harness=1`,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
  }],
  ['GET', /^\/api\/v1\/pairing\/sessions\/([^/]+)$/, ({ world }, m) => {
    const session = pairings(world).get(m[1]!);
    if (!session) return json({ error: 'session_not_found' }, 404);
    const phone = `${PEOPLE[LINKED_PERSON].name.split(' ')[0]}'s phone`;
    const elapsed = Date.now() - session.createdAt;
    if (session.cancelled) return json({ state: 'cancelled', outcome: '', code: '', peerDeviceName: '', error: '' });
    if (elapsed < 6000) return json({ state: 'created', outcome: '', code: '', peerDeviceName: '', error: '' });
    if (elapsed < 12000) return json({ state: 'acked', outcome: 'phone-to-desktop', code: '042917', peerDeviceName: phone, error: '' });
    return json({ state: 'identity-received', outcome: 'phone-to-desktop', code: '042917', peerDeviceName: phone, error: '' });
  }],
  ['GET', /^\/api\/v1\/pairing\/sessions\/([^/]+)\/identity$/, ({ world }, m) => {
    if (!pairings(world).has(m[1]!)) return json({ error: 'session_not_found' }, 404);
    const person = PEOPLE[LINKED_PERSON];
    return json({ mnemonic: person.mnemonic, aid: person.aid, orgAid: ORG.aid });
  }],
  ['POST', /^\/api\/v1\/pairing\/sessions\/([^/]+)\/cancel$/, ({ world }, m) => {
    const session = pairings(world).get(m[1]!);
    if (session) session.cancelled = true;
    return json({ success: true });
  }],
];

function pairings(world: World): Map<string, { createdAt: number; cancelled: boolean }> {
  return ((world.extra.pairings as Map<string, { createdAt: number; cancelled: boolean }> | undefined) ??=
    new Map()) as Map<string, { createdAt: number; cancelled: boolean }>;
}

/**
 * Runs before any app module: moves `localhost` to `127.0.0.1` (one origin for
 * both backend URL forms), settles the platform (`?platform=`, else the last
 * choice, else desktop), and on desktop installs a stand-in for Electron's
 * preload bridge (src-electron/electron-preload.ts) — secure storage on
 * localStorage, the dev server's own port as the backend port, window
 * controls as no-ops.
 */
const platformScript = `
(function () {
  if (location.hostname === 'localhost') {
    location.replace(location.href.replace('//localhost:', '//127.0.0.1:'));
    return;
  }
  var asked = new URLSearchParams(location.search).get('platform');
  var platform = asked || localStorage.getItem('${PLATFORM_KEY}') || '${DEFAULT_PLATFORM}';
  localStorage.setItem('${PLATFORM_KEY}', platform);
  if (platform !== 'desktop') return;
  var done = function (v) { return function () { return Promise.resolve(v); }; };
  window.electronAPI = {
    isElectron: true,
    platform: 'linux',
    getBackendPort: done(location.port || '80'),
    getDataDir: done('/harness'),
    getApiToken: done('harness-api-token'),
    secureStorageGet: function (k) { return Promise.resolve(localStorage.getItem(k)); },
    secureStorageSet: function (k, v) { localStorage.setItem(k, v); return Promise.resolve(); },
    secureStorageRemove: function (k) { localStorage.removeItem(k); return Promise.resolve(); },
    windowMinimize: done(), windowMaximize: done(), windowClose: done(), windowIsMaximized: done(false),
    onUpdateDownloaded: function () {}, installUpdate: done(),
    notify: function (p) { console.info('[harness] desktop notification', p); },
    onNotificationClicked: function () {}, onDeepLink: function () {},
  };
})();`;

let TYPES: Array<{ name: string }> = [];

interface KitEntry {
  id: string;
  name: string;
  primary: string;
  secondary: string;
}

/** The kits run.mjs can switch between (MATOU_HARNESS_KITS: id -> directory), and the one applied. */
function kitCatalogue(): { current: string; kits: KitEntry[] } {
  const dirs = JSON.parse(process.env.MATOU_HARNESS_KITS ?? '{}') as Record<string, string>;
  const kits: KitEntry[] = [];
  for (const [id, dir] of Object.entries(dirs)) {
    try {
      const kit = JSON.parse(readFileSync(join(dir, 'kit.json'), 'utf8')) as {
        brand: { name: string; primaryColour: string; secondaryColour: string };
      };
      kits.push({ id, name: kit.brand.name, primary: kit.brand.primaryColour, secondary: kit.brand.secondaryColour });
    } catch {
      /* an unreadable kit is left out of the picker */
    }
  }
  return { current: process.env.MATOU_HARNESS_KIT ?? '', kits };
}

function scenarioFrom(req: IncomingMessage): string | null {
  const cookie = req.headers.cookie ?? '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SCENARIO_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function meFrom(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer harness.') ? auth.slice('Bearer harness.'.length) : '';
  return token || (req.headers['x-user-aid'] as string | undefined) || null;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    try { return JSON.parse(buf.toString('utf8')); } catch { return undefined; }
  }
  // multipart uploads: keep the raw bytes; the harness only needs to hand them back
  return { type: type.includes('multipart') ? 'application/octet-stream' : type, body: buf };
}

export function harnessBackend(root: string): Plugin {
  TYPES = JSON.parse(readFileSync(join(root, 'tests/preview-harness/fixtures/types.json'), 'utf8'));
  const worlds = new Map<string, World>();
  const worldFor = (id: string) => {
    let w = worlds.get(id);
    if (!w) {
      w = buildWorld(scenarioById(id), kitName(root));
      worlds.set(id, w);
    }
    return w;
  };
  const routes: Route[] = [...coreRoutes, ...dashboardRoutes(root)];
  const unmodelled = new Set<string>();

  return {
    name: 'matou-preview-harness-backend',
    configureServer(server) {
      const handle = async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://harness');
        const method = (req.method ?? 'GET').toUpperCase();
        const scenario = scenarioById(url.searchParams.get('scenario') ?? scenarioFrom(req)).id;

        // The picker's kit list and kit switch. A switch is handed to run.mjs
        // (our parent, over IPC), which restarts this dev server on the new kit.
        if (url.pathname === '/__kits') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(kitCatalogue()));
          return;
        }
        if (url.pathname === '/__kit' && method === 'POST') {
          const id = url.searchParams.get('id') ?? '';
          const known = kitCatalogue().kits.some((k) => k.id === id);
          res.statusCode = known && process.send ? 202 : 400;
          res.end();
          if (known) process.send?.({ type: 'switch-kit', id });
          return;
        }

        if (url.pathname === '/__reset') {
          worlds.delete(scenario);
          res.statusCode = 204;
          res.end();
          return;
        }

        // The backend's server-sent events: hold the stream open, never push.
        if (url.pathname === '/api/v1/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write(': harness\n\n');
          const ping = setInterval(() => res.write(': ping\n\n'), 15000);
          req.on('close', () => clearInterval(ping));
          return;
        }

        const body = await readBody(req);
        const r: Req = { method, path: url.pathname, query: url.searchParams, body, me: meFrom(req), world: worldFor(scenario) };
        let reply: Reply;
        for (const [m, pattern, handler] of routes) {
          if (m !== method) continue;
          const match = url.pathname.match(pattern);
          if (match) {
            reply = handler(r, match);
            break;
          }
        }
        if (!reply) {
          const key = `${method} ${url.pathname.replace(/\/E[A-Za-z0-9_-]{20,}/g, '/:aid')}`;
          if (!unmodelled.has(key)) {
            unmodelled.add(key);
            server.config.logger.info(`[harness] unmodelled ${key}`);
          }
          reply = method === 'GET' ? json({ error: 'harness: not modelled' }, 404) : json({ success: true });
        }
        res.statusCode = reply!.status ?? 200;
        if (reply!.raw) {
          res.setHeader('content-type', reply!.raw.type);
          res.end(reply!.raw.body);
        } else {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(reply!.json ?? null));
        }
      };
      server.middlewares.use(FAKE_PREFIX, handle);
      // The desktop platform's backend URL has no prefix (see the header).
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!;
        if (path.startsWith('/api/') || path === '/health') void handle(req, res);
        else next();
      });
    },
    transformIndexHtml: () => [{ tag: 'script', children: platformScript, injectTo: 'head-prepend' }],
  };
}
