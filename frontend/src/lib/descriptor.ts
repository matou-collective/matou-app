/**
 * Community backend descriptor loader (ADR 0226, amended by ADRs 0235/0236).
 *
 * A Coa build bakes exactly one URL and reads the community backend descriptor
 * at `GET <url>/api/client-config`. On an IDSS gateway that document is the
 * `1.1` descriptor the control plane renders from the roster: one community
 * witness rather than six, the gateway's own schema OOBIs, a `signin` block
 * where `doorkeeper` used to be, and — until the operator designs the app or
 * any-sync is installed — no `anysync` and no `app` key at all.
 *
 * This module is the wallet's half of that contract: it parses the document,
 * tolerates every optional block, and refuses only what it genuinely cannot
 * understand (an unknown `version` major). Its shape mirrors idss's
 * `internal/orgconfig` writer — one source, two repos — and its tests run
 * against the same golden documents.
 */

/**
 * The descriptor major the wallet understands. The version is an additive
 * minor bump (ADR 0226 decision 5): every new block is optional, so a newer
 * `1.x` document keeps working and the wallet simply has nothing to show for
 * the blocks it does not read. The ONLY hard refusal is a major this wallet
 * does not know.
 */
export const KNOWN_DESCRIPTOR_MAJOR = 1;

/** `backend_kind` for a gateway-served descriptor (ADR 0226 decision 5). */
export const BACKEND_KIND_IDSS = 'idss';

/**
 * The Mātou (coa-shared) Membership schema SAID. This is the built-in fallback
 * for a descriptor that names no membership schema — a coa-shared backend, with
 * no `schemas` block, whose one shared schema every community issues under. An
 * IDSS community names its OWN Membership schema in `schemas.membership.said`
 * (ADR 0226 decision 5) and that always wins; this constant is used only in its
 * absence (issue #615).
 */
export const MATOU_MEMBERSHIP_SCHEMA_SAID = 'ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI';

export interface DescriptorCommunity {
  name: string;
  slug: string;
  /** The community group identity — the issuer of every credential. */
  aid: string;
  /** The community identity's bare OOBI (it survives agent re-boots). */
  oobi: string;
  /** The one community ledger's identifier (ADR 0235). */
  registry: string;
}

/** One active steward as an admin entry (ADR 0235). */
export interface DescriptorSteward {
  aid: string;
  name?: string;
  oobi: string;
}

/** One credential kind's SAID and public OOBI (ADR 0226 decision 5). */
export interface DescriptorSchema {
  said: string;
  oobi: string;
}

/** The wallet's boot posture (ADR 0226 decision 5, ADR 0235). */
export interface DescriptorBoot {
  gated: boolean;
  join_url: string;
}

/** The bridge's sign-in endpoint — the home community's door (ADR 0236). */
export interface DescriptorSignin {
  url: string;
}

/** The gateway's pinned KERI generations (ADR 0226 decision 5). */
export interface DescriptorStack {
  keria: string;
  keripy?: string;
  signify?: string;
}

/** The community app pointer, present only once an app exists (ADR 0226). */
export interface DescriptorApp {
  name: string;
  downloads_url: string;
  platforms?: string[];
}

/**
 * The whole community backend descriptor as it rests in the config server and
 * is served at `/api/config` and `/api/client-config`. Every block below the
 * two fixed leads is optional to a degree: `anysync` and `app` are omitted
 * until they exist, and the retired `doorkeeper` block is tolerated and
 * dropped.
 */
export interface CommunityDescriptor {
  version: string;
  backend_kind: string;
  community?: DescriptorCommunity;
  admins: DescriptorSteward[];
  api_url?: string;
  schemas: Record<string, DescriptorSchema>;
  boot?: DescriptorBoot;
  signin?: DescriptorSignin;
  stack?: DescriptorStack;
  /** Present only once the community app record reaches ready. */
  app?: DescriptorApp;
  /** Present only when any-sync is installed on the gateway. */
  anysync?: Record<string, unknown>;
}

/**
 * Thrown when the descriptor's `version` major is one this wallet does not
 * know. This is the ONLY hard refusal (ADR 0226 decision 5); a `stack`
 * mismatch and every absent optional block are tolerated.
 */
export class UnsupportedDescriptorVersionError extends Error {
  readonly version: string;
  readonly major: number;
  constructor(version: string, major: number) {
    super(
      `Community backend descriptor version "${version}" (major ${major}) is newer than this wallet understands (major ${KNOWN_DESCRIPTOR_MAJOR}). Update the app to join this community.`,
    );
    this.name = 'UnsupportedDescriptorVersionError';
    this.version = version;
    this.major = major;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse the leading integer of a `major.minor` version string. */
function versionMajor(version: string): number {
  return parseInt(String(version).split('.')[0] ?? '', 10);
}

/**
 * Parse and validate a raw community backend descriptor.
 *
 * Refuses ONLY an unknown `version` major (an absent or unparseable version is
 * treated as such). Every optional block is tolerated: an absent `anysync`,
 * `app` or `signin` is simply dropped, and the retired `doorkeeper` block is
 * stripped rather than surfaced. A malformed non-object throws a plain Error.
 */
export function parseDescriptor(raw: unknown): CommunityDescriptor {
  if (!isRecord(raw)) {
    throw new Error('Community backend descriptor must be a JSON object');
  }

  const version = typeof raw.version === 'string' ? raw.version : '';
  const major = versionMajor(version);
  // An unknown or unparseable major is the one hard refusal. A wallet on major
  // 1 keeps working against any 1.x document (additive minor bumps).
  if (!Number.isInteger(major) || major > KNOWN_DESCRIPTOR_MAJOR) {
    throw new UnsupportedDescriptorVersionError(version, major);
  }

  const admins: DescriptorSteward[] = Array.isArray(raw.admins)
    ? (raw.admins as unknown[]).filter(isRecord).map((a) => ({
        aid: String(a.aid ?? ''),
        ...(typeof a.name === 'string' ? { name: a.name } : {}),
        oobi: String(a.oobi ?? ''),
      }))
    : [];

  const schemas: Record<string, DescriptorSchema> = {};
  if (isRecord(raw.schemas)) {
    for (const [kind, entry] of Object.entries(raw.schemas)) {
      if (isRecord(entry)) {
        schemas[kind] = { said: String(entry.said ?? ''), oobi: String(entry.oobi ?? '') };
      }
    }
  }

  const descriptor: CommunityDescriptor = {
    version: version || `${KNOWN_DESCRIPTOR_MAJOR}.0`,
    backend_kind: typeof raw.backend_kind === 'string' ? raw.backend_kind : '',
    admins,
    schemas,
  };

  if (isRecord(raw.community)) {
    const c = raw.community;
    descriptor.community = {
      name: String(c.name ?? ''),
      slug: String(c.slug ?? ''),
      aid: String(c.aid ?? ''),
      oobi: String(c.oobi ?? ''),
      registry: String(c.registry ?? ''),
    };
  }

  if (typeof raw.api_url === 'string') descriptor.api_url = raw.api_url;

  if (isRecord(raw.boot)) {
    descriptor.boot = {
      gated: raw.boot.gated === true,
      join_url: String(raw.boot.join_url ?? ''),
    };
  }

  // signin replaces the retired doorkeeper block (ADR 0236). A `doorkeeper`
  // key, if any older gateway still serves it, is simply not read.
  if (isRecord(raw.signin) && typeof raw.signin.url === 'string') {
    descriptor.signin = { url: raw.signin.url };
  }

  if (isRecord(raw.stack)) {
    descriptor.stack = {
      keria: String(raw.stack.keria ?? ''),
      ...(typeof raw.stack.keripy === 'string' ? { keripy: raw.stack.keripy } : {}),
      ...(typeof raw.stack.signify === 'string' ? { signify: raw.stack.signify } : {}),
    };
  }

  // app is written only once an app exists; absent is the common case.
  if (isRecord(raw.app)) {
    descriptor.app = {
      name: String(raw.app.name ?? ''),
      downloads_url: String(raw.app.downloads_url ?? ''),
      ...(Array.isArray(raw.app.platforms)
        ? { platforms: (raw.app.platforms as unknown[]).map(String) }
        : {}),
    };
  }

  // anysync is a passthrough — its shape is matou-infrastructure's, not ours —
  // and is served only when any-sync is installed. Absent is fine (the content
  // surfaces render their empty state).
  if (isRecord(raw.anysync)) {
    descriptor.anysync = raw.anysync;
  }

  return descriptor;
}

/** True once any-sync is installed on the gateway (the content layer exists). */
export function hasContentLayer(d: CommunityDescriptor): boolean {
  return isRecord(d.anysync) && Object.keys(d.anysync).length > 0;
}

/**
 * The community's three any-sync space IDs, as recorded in the descriptor once
 * idss has a whole set (the 2026-09-15 ADR 0226 spaces amendment). They ride
 * INSIDE the `anysync` block under matou-app's own camelCase keys — beside the
 * network config, NOT in a separate block.
 */
export interface RecordedSpaces {
  communitySpaceId: string;
  readOnlySpaceId: string;
  adminSpaceId: string;
}

/**
 * Read the community's three recorded space IDs from the descriptor's `anysync`
 * block. idss merges the three keys in **together or not at all** (they appear
 * only once the record is whole), so this returns them only when all three are
 * present and non-empty, and `null` otherwise.
 *
 * `null` with {@link hasContentLayer} true is the signal this ticket's fallback
 * turns on: the content layer exists but its spaces have not been created yet
 * (issue #534). The three keys present is the join case (AC4) — nothing to
 * create.
 */
export function recordedSpaces(d: CommunityDescriptor): RecordedSpaces | null {
  const a = d.anysync;
  if (!isRecord(a)) return null;
  const communitySpaceId = typeof a.communitySpaceId === 'string' ? a.communitySpaceId : '';
  const readOnlySpaceId = typeof a.readOnlySpaceId === 'string' ? a.readOnlySpaceId : '';
  const adminSpaceId = typeof a.adminSpaceId === 'string' ? a.adminSpaceId : '';
  if (!communitySpaceId || !readOnlySpaceId || !adminSpaceId) return null;
  return { communitySpaceId, readOnlySpaceId, adminSpaceId };
}

/**
 * The Membership schema SAID this community issues under: the one the
 * descriptor names in `schemas.membership.said`, falling back to the Mātou
 * constant only for a descriptor that names no membership schema (a coa-shared
 * backend with no `schemas` block). This is the schema every membership check
 * must match — a correctly issued IDSS credential is of the community's own
 * schema, never the Mātou one (issue #615).
 */
export function membershipSchemaSaid(d: CommunityDescriptor): string {
  return d.schemas.membership?.said || MATOU_MEMBERSHIP_SCHEMA_SAID;
}

/**
 * The Membership schema OOBI from the descriptor's `schemas` block, or
 * `undefined` when the document names none (a coa-shared backend, whose schema
 * OOBI comes from the legacy org config or the dev schema server instead).
 */
export function membershipSchemaOobi(d: CommunityDescriptor): string | undefined {
  const oobi = d.schemas.membership?.oobi;
  return oobi && oobi.length > 0 ? oobi : undefined;
}

/**
 * The schema OOBIs the wallet resolves, taken from the descriptor's `schemas`
 * block rather than a built-in list (ADR 0226 decision 5).
 */
export function schemaOobis(d: CommunityDescriptor): string[] {
  return Object.values(d.schemas)
    .map((s) => s.oobi)
    .filter((oobi) => oobi.length > 0);
}

/** The home community's sign-in door, pre-trusted from the baked descriptor. */
export function signinUrl(d: CommunityDescriptor): string | undefined {
  return d.signin?.url;
}

/**
 * Describe any KERI-generation mismatch between the gateway's pinned `stack`
 * and the wallet's own generations. Per ADR 0226 decision 5 this is a
 * diagnostics warning, NEVER a refusal — it makes the crossing visible rather
 * than silent. Returns one human-readable line per differing generation.
 */
export function describeStackMismatch(
  d: CommunityDescriptor,
  wallet: DescriptorStack,
): string[] {
  const warnings: string[] = [];
  const stack = d.stack;
  if (!stack) return warnings;
  const check = (label: string, gateway?: string, mine?: string) => {
    if (gateway && mine && gateway !== mine) {
      warnings.push(`${label}: gateway ${gateway}, wallet ${mine}`);
    }
  };
  check('KERIA', stack.keria, wallet.keria);
  check('keripy', stack.keripy, wallet.keripy);
  check('signify', stack.signify, wallet.signify);
  return warnings;
}
