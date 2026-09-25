/**
 * The preview harness's scenarios — one named world the app can be clicked
 * through in, with no backend, config server or KERIA running. Pure data: the
 * browser boot (`boot.ts`, the fake KERIA side) and the dev-server plugin
 * (`backendPlugin.ts`, the fake backend side) both read this file, so the two
 * halves of a world always agree on who is who.
 *
 * Adding a scenario = one more entry in {@link SCENARIOS}. The harness reads
 * `?scenario=<id>` and falls back to `registration`.
 */

/** The community every scenario lives in (the org identity + its ledger). */
export const ORG = {
  aid: 'EHarnessOrgAid00000000000000000000000000000',
  registry: 'EHarnessRegistry0000000000000000000000000000',
  communitySpaceId: 'bafyharnesscommunityspace',
  readOnlySpaceId: 'bafyharnessreadonlyspace',
  adminSpaceId: 'bafyharnessadminspace',
} as const;

/** The Mātou Membership schema — a coa-shared descriptor names no `schemas` block. */
export const MEMBERSHIP_SCHEMA = 'ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI';

export interface Person {
  readonly aid: string;
  readonly name: string;
  readonly alias: string;
  readonly role: string;
  readonly email: string;
  readonly location: string;
  readonly bio: string;
  readonly interests: readonly string[];
  /** Initial-coloured avatar tone; the fake backend draws it as an SVG. */
  readonly tone: string;
  /** A valid BIP39 phrase: Recover identity with it signs in as this person. */
  readonly mnemonic: string;
}

/** The people the fake community is made of. `me` is whoever the scenario signs in as. */
export const PEOPLE = {
  aroha: {
    aid: 'EHarnessAroha000000000000000000000000000000',
    name: 'Aroha Ngata',
    alias: 'aroha-ngata',
    role: 'Founding Member',
    email: 'aroha@example.nz',
    location: 'Ōpōtiki',
    bio: 'Kaitiaki of the community app and the one who says yes to new members.',
    interests: ['Coordination and Operations', 'Discussions and Community Input'],
    tone: '#7d2431',
    mnemonic: 'alpha movie energy grid tonight pretty laundry exchange letter frequent position flag',
  },
  tama: {
    aid: 'EHarnessTama0000000000000000000000000000000',
    name: 'Tama Rēweti',
    alias: 'tama-reweti',
    role: 'Member',
    email: 'tama@example.nz',
    location: 'Tauranga',
    bio: 'Runs the kapa haka practice roster and the Friday kai.',
    interests: ['Art and Designs', 'Follow and Learn'],
    tone: '#1e5f74',
    mnemonic: 'club ring nation radio dad devote banana viable pizza magic vast phrase',
  },
  mere: {
    aid: 'EHarnessMere0000000000000000000000000000000',
    name: 'Mere Tūhoe',
    alias: 'mere-tuhoe',
    role: 'Member',
    email: 'mere@example.nz',
    location: 'Whakatāne',
    bio: 'Researcher; keeps the whakapapa records tidy.',
    interests: ['Research and Knowledge'],
    tone: '#3c513b',
    mnemonic: 'eyebrow tobacco symptom wild matrix soon plug obey skull pyramid depend unknown',
  },
  wiremu: {
    aid: 'EHarnessWiremu00000000000000000000000000000',
    name: 'Wiremu Pōtae',
    alias: 'wiremu-potae',
    role: 'Member',
    email: 'wiremu@example.nz',
    location: 'Rotorua',
    bio: 'Waiting to be let in.',
    interests: ['Coding and Technical Dev'],
    tone: '#e3a72f',
    mnemonic: 'isolate arrest chalk earn swear giggle derive develop useful south dune cute',
  },
  hine: {
    aid: 'EHarnessHine0000000000000000000000000000000',
    name: 'Hine Kāwhia',
    alias: 'hine-kawhia',
    role: 'Member',
    email: 'hine@example.nz',
    location: 'Kirikiriroa',
    bio: 'Applied last week — wants to help with events.',
    interests: ['Follow and Learn', 'Art and Designs'],
    tone: '#6c2bd9',
    mnemonic: 'option culture hundred moral column virtual soup scorpion beef welcome minute liar',
  },
} as const satisfies Record<string, Person>;

export type PersonId = keyof typeof PEOPLE;

/** Who the scripted phone signs this desktop in as ("Sign in with desktop"). */
export const LINKED_PERSON: PersonId = 'tama';

/** Who is an approved member of the community (the rest are applicants). */
export const MEMBERS: readonly PersonId[] = ['aroha', 'tama', 'mere'];
/** Who has applied and is waiting for a steward. */
export const APPLICANTS: readonly PersonId[] = ['wiremu', 'hine'];

export interface Scenario {
  readonly id: string;
  readonly label: string;
  /** One sentence for the picker's tooltip. */
  readonly blurb: string;
  /**
   * Who the wallet already holds, or null for a fresh install (no passcode, no
   * AID — the splash offers Register). The fake KERIA side is seeded from this.
   */
  readonly signedInAs: PersonId | null;
  /** Whether the signed-in person holds the community Membership credential. */
  readonly member: boolean;
  /** Whether the signed-in person's credential carries a steward role. */
  readonly steward: boolean;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'registration',
    label: 'Registration',
    blurb: 'Fresh install: Register → welcome → info pages → profile → recovery words → submitted. Stops at pending approval.',
    signedInAs: null,
    member: false,
    steward: false,
  },
  {
    id: 'pending',
    label: 'Pending approval',
    blurb: 'Wiremu has registered and is waiting for a steward to approve him.',
    signedInAs: 'wiremu',
    member: false,
    steward: false,
  },
  {
    id: 'member',
    label: 'Member dashboard',
    blurb: 'Tama is an approved member: chat, notices and events are full.',
    signedInAs: 'tama',
    member: true,
    steward: false,
  },
  {
    id: 'steward',
    label: 'Steward',
    blurb: 'Aroha is a founding steward with two registrations waiting for her.',
    signedInAs: 'aroha',
    member: true,
    steward: true,
  },
];

export const DEFAULT_SCENARIO = 'registration';

export function scenarioById(id: string | null | undefined): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS.find((s) => s.id === DEFAULT_SCENARIO)!;
}

/**
 * Which shell the app believes it runs in. `desktop` stands in for Electron's
 * preload bridge (title bar, "Sign in with desktop", the Electron backend
 * URL); `browser` is the plain SPA. A phone shell needs Capacitor's native
 * plugins and is not modelled.
 */
export const PLATFORMS = [
  { id: 'desktop', label: 'Desktop' },
  { id: 'browser', label: 'Browser' },
] as const;
export type PlatformId = (typeof PLATFORMS)[number]['id'];
export const DEFAULT_PLATFORM: PlatformId = 'desktop';
/** localStorage key the platform choice is remembered under (read before the app loads). */
export const PLATFORM_KEY = 'matou-harness:platform';

/** The cookie that carries the chosen scenario to the fake backend. */
export const SCENARIO_COOKIE = 'matou_harness_scenario';
/** Where the fake backend is mounted on the dev server. */
export const FAKE_PREFIX = '/__fake';
