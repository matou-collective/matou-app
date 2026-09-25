/**
 * The harness's KERIA: the app's one KERIClient singleton with every method
 * answered from a small in-browser wallet instead of signify-ts talking to a
 * real agent. The wallet (AIDs + held credentials) lives in localStorage, so a
 * reload mid-registration comes back to the same identity, exactly as a real
 * wallet would.
 *
 * Only what the click-through paths read is modelled (list/create AIDs, list
 * credentials, a signed challenge, OOBIs, the registration send). Every other
 * KERIClient method resolves to `undefined` and logs once, so an unmodelled
 * path is visible in the console rather than a hang on a KERIA that isn't
 * there.
 */
import { KERIClient, useKERIClient, type AIDInfo } from 'src/lib/keri/client';
import { KIT } from 'src/generated/kit';
import { MEMBERS, MEMBERSHIP_SCHEMA, ORG, PEOPLE, type PersonId, type Scenario } from './scenarios';

const WALLET_KEY = 'matou-harness:wallet';

interface HeldCredential {
  sad: { d: string; s: string; i: string; ri: string; a: Record<string, unknown> & { i: string } };
  schema: { title: string; credentialType: string };
  status: { s: string; et: string };
  chains: unknown[];
}

interface Wallet {
  aids: AIDInfo[];
  credentials: HeldCredential[];
}

const said = (seed: string) => `E${seed.replace(/[^A-Za-z0-9]/g, '').padEnd(43, '0').slice(0, 43)}`;

function membershipCredential(holder: AIDInfo, role: string): HeldCredential {
  return {
    sad: {
      d: said(`HarnessCred${holder.prefix.slice(8, 20)}`),
      s: MEMBERSHIP_SCHEMA,
      i: ORG.aid,
      ri: ORG.registry,
      a: {
        i: holder.prefix,
        dt: '2026-09-01T09:00:00.000Z',
        communityName: KIT.brand.name,
        role,
        verificationStatus: 'community_verified',
        permissions: role.toLowerCase().includes('steward') || role.toLowerCase().includes('founding')
          ? ['read', 'comment', 'vote', 'propose', 'moderate', 'admin']
          : ['read', 'comment', 'vote', 'propose'],
        joinedAt: '2026-09-01T09:00:00.000Z',
      },
    },
    schema: { title: 'Membership', credentialType: 'MembershipCredential' },
    status: { s: '0', et: 'iss' },
    chains: [],
  };
}

/** The wallet a scenario starts with. */
/** One person's wallet: their AID, and their Membership credential if they hold one. */
function personWallet(id: PersonId, member: boolean): Wallet {
  const person = PEOPLE[id];
  const aid: AIDInfo = { prefix: person.aid, name: person.alias, state: {} };
  return { aids: [aid], credentials: member ? [membershipCredential(aid, person.role)] : [] };
}

/** The wallet a scenario starts with. */
export function seedWallet(scenario: Scenario): Wallet {
  if (!scenario.signedInAs) return { aids: [], credentials: [] };
  return personWallet(scenario.signedInAs, scenario.member);
}

/** The passcode a person's phrase derives — what the app connects with after a recovery or link. */
export function passcodeOf(id: PersonId): string {
  return KERIClient.passcodeFromMnemonic(PEOPLE[id].mnemonic);
}

function loadWallet(): Wallet {
  try {
    const raw = localStorage.getItem(WALLET_KEY);
    if (raw) return JSON.parse(raw) as Wallet;
  } catch {
    /* fall through to empty */
  }
  return { aids: [], credentials: [] };
}

export function saveWallet(w: Wallet): void {
  localStorage.setItem(WALLET_KEY, JSON.stringify(w));
}

const resolved = <T>(v: T) => Promise.resolve(v);

/** A SignifyClient-shaped object: only the resources the app calls. */
function fakeSignify(wallet: () => Wallet) {
  const warned = new Set<string>();
  // Any resource method nobody modelled resolves empty rather than throwing.
  const resource = <T extends object>(name: string, impl: T): T =>
    new Proxy(impl, {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        return (..._args: unknown[]) => {
          if (!warned.has(`${name}.${prop}`)) {
            warned.add(`${name}.${prop}`);
            console.debug(`[harness] SignifyClient ${name}().${prop} is not modelled — resolving empty`);
          }
          return resolved(undefined);
        };
      },
    });

  const identifiers = resource('identifiers', {
    list: () => resolved({ aids: wallet().aids, start: 0, end: wallet().aids.length, total: wallet().aids.length }),
    get: (name: string) => {
      const aid = wallet().aids.find((a) => a.name === name || a.prefix === name);
      return resolved(aid ? { ...aid, state: { i: aid.prefix, s: '0', k: [], n: [] }, windexes: [] } : null);
    },
  });
  const credentials = resource('credentials', {
    list: () => resolved(wallet().credentials),
    get: (d: string) => resolved(wallet().credentials.find((c) => c.sad.d === d) ?? null),
  });
  const schemas = resource('schemas', {
    get: (s: string) => resolved({ $id: s, title: 'Membership', credentialType: 'MembershipCredential', properties: {} }),
    list: () => resolved([]),
  });
  const notifications = resource('notifications', {
    list: () => resolved({ notes: [], start: 0, end: 0, total: 0 }),
    mark: () => resolved(''),
  });
  const keyStates = resource('keyStates', {
    get: (pre: string) => resolved([{ i: pre, s: '0', d: pre }]),
    // one witness, so a steward's dashboard skips the "adopt witnesses" migration banner
    query: (pre: string) =>
      resolved({ name: `query.${pre}`, done: true, response: { i: pre, s: '0', b: ['BHarnessWitness000000000000000000000000000'] } }),
  });
  const operations = resource('operations', {
    wait: <T>(op: T) => resolved({ ...(op as object), done: true }),
    get: (name: string) => resolved({ name, done: true }),
    delete: () => resolved(undefined),
  });
  const exchanges = resource('exchanges', { get: () => resolved(null) });
  const oobis = resource('oobis', {
    get: (name: string) => resolved({ oobis: [`http://localhost:3902/oobi/${name}`] }),
    resolve: (oobi: string) => resolved({ name: `oobi.${oobi}`, done: true }),
  });
  const contacts = resource('contacts', { list: () => resolved([]) });
  const registries = resource('registries', { list: () => resolved([{ regk: ORG.registry, name: 'harness' }]) });
  const ipex = resource('ipex', {});
  const groups = resource('groups', {});
  const escrows = resource('escrows', { listReply: () => resolved([]) });

  return {
    agent: { pre: 'EHarnessAgent00000000000000000000000000000' },
    controller: { pre: 'EHarnessController000000000000000000000000' },
    identifiers: () => identifiers,
    credentials: () => credentials,
    schemas: () => schemas,
    notifications: () => notifications,
    keyStates: () => keyStates,
    operations: () => operations,
    exchanges: () => exchanges,
    oobis: () => oobis,
    contacts: () => contacts,
    registries: () => registries,
    ipex: () => ipex,
    groups: () => groups,
    escrows: () => escrows,
    connect: () => resolved(undefined),
    boot: () => resolved(new Response('{}')),
    state: () => resolved({ agent: { i: 'EHarnessAgent' }, controller: { state: { i: 'EHarnessController' } } }),
  };
}

function randomPrefix(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = 'E';
  for (let i = 0; i < 43; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Replace every method on the app's KERIClient singleton with the fake wallet.
 * Runs before `boot/keri.ts`, so the app never sees the real client.
 */
export function installFakeKeria(): void {
  const client = useKERIClient() as unknown as Record<string, unknown>;
  let connected = false;
  const signify = fakeSignify(loadWallet);

  const fakes: Record<string, (...args: never[]) => unknown> = {
    // --- sync methods: must NOT return promises
    isConnected: () => connected,
    getSignifyClient: () => (connected ? signify : null),
    getPendingAgentReboot: () => null,
    getCesrUrl: () => 'http://localhost:3902',
    getOrgOOBI: () => `http://localhost:3902/oobi/${ORG.aid}`,
    setOrgAID: () => undefined,
    // --- async methods the click-through paths depend on
    initialize: async (bran: string) => {
      // A harness person's passcode (Recover identity with their phrase, or a
      // desktop link from the scripted phone) opens that person's wallet, as
      // KERIA would hand back the agent the phrase derives.
      const who = (Object.keys(PEOPLE) as PersonId[]).find((id) => passcodeOf(id) === bran);
      if (who && !loadWallet().aids.some((a) => a.prefix === PEOPLE[who].aid)) {
        saveWallet(personWallet(who, MEMBERS.includes(who)));
      }
      connected = true;
      client.client = signify;
    },
    ensureSession: async () => undefined,
    listAIDs: async () => loadWallet().aids,
    getAID: async (name: string) => loadWallet().aids.find((a) => a.name === name) ?? null,
    createAID: async (name: string) => {
      await new Promise((r) => setTimeout(r, 600)); // an inception takes a moment
      const wallet = loadWallet();
      const aid: AIDInfo = { prefix: randomPrefix(), name, state: {} };
      wallet.aids.push(aid);
      saveWallet(wallet);
      return aid;
    },
    signChallenge: async () => 'harness-signature',
    getOOBI: async (aid: string) => `http://localhost:3902/oobi/${aid}/agent/EHarnessAgent`,
    resolveOOBI: async () => true,
    resolveOOBIWithReason: async () => ({ ok: true }),
    resolveViaWitnesses: async () => 1,
    refreshKeyState: async () => true,
    queryKeyStateToSn: async () => null,
    sendRegistrationToAdmins: async (_aid: string, admins: Array<{ aid: string }>) => {
      await new Promise((r) => setTimeout(r, 800));
      return { success: true, sent: admins.map((a) => a.aid), failed: [] };
    },
    sendEXN: async () => ({ success: true }),
    listNotifications: async () => [],
    markNotificationRead: async () => undefined,
    clearAgentRebootMarker: async () => undefined,
    republishAgentEndRole: async () => undefined,
    // a steward approving a registration: issue + grant land nowhere, but return a SAID
    issueCredential: async () => {
      await new Promise((r) => setTimeout(r, 800));
      return { said: randomPrefix() };
    },
    grantCredential: async () => undefined,
    pushKelToAgent: async () => undefined,
  };

  const warned = new Set<string>();
  for (const name of Object.getOwnPropertyNames(KERIClient.prototype)) {
    if (name === 'constructor') continue;
    // Accessors (keriaUrl, …) stay as they are; only methods are swapped.
    const desc = Object.getOwnPropertyDescriptor(KERIClient.prototype, name);
    if (!desc || typeof desc.value !== 'function') continue;
    client[name] = fakes[name] ?? (async () => {
      if (!warned.has(name)) {
        warned.add(name);
        console.debug(`[harness] KERIClient.${name} is not modelled — resolving undefined`);
      }
      return undefined;
    });
  }
}
