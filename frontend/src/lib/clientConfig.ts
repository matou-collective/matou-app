/**
 * Client Configuration
 *
 * Fetches infrastructure configuration from the config server.
 * All KERI URLs, witness info, and anysync config come from a single source.
 *
 * Environment variables:
 *   VITE_DEV_CONFIG_URL  - Config server URL for development (default)
 *   VITE_TEST_CONFIG_URL - Config server URL for test environment
 *   VITE_PROD_CONFIG_URL - Config server URL for production
 *   VITE_ENV             - Environment: 'dev' | 'test' | 'prod' (default: 'dev')
 *   VITE_BACKEND_URL     - Backend API URL (still separate per-session)
 */

import { secureStorage } from './secureStorage';
import { isCapacitor, getBackendUrl } from './platform';
import {
  parseDescriptor,
  UnsupportedDescriptorVersionError,
  schemaOobis as descriptorSchemaOobis,
  membershipSchemaSaid as descriptorMembershipSchemaSaid,
  membershipSchemaOobi as descriptorMembershipSchemaOobi,
  signinUrl as descriptorSigninUrl,
  type CommunityDescriptor,
  type DescriptorCommunity,
  type DescriptorSteward,
  type DescriptorSchema,
  type DescriptorBoot,
  type DescriptorSignin,
  type DescriptorStack,
  type DescriptorApp,
} from './descriptor';

// Environment-based config URL selection
const ENV = (import.meta.env.VITE_ENV as string) || 'dev';
const CONFIG_URLS: Record<string, string> = {
  dev: import.meta.env.VITE_DEV_CONFIG_URL || 'http://localhost:3904',
  test: import.meta.env.VITE_TEST_CONFIG_URL || 'http://localhost:4904',
  prod: import.meta.env.VITE_PROD_CONFIG_URL || '',
};

const CONFIG_URL = CONFIG_URLS[ENV] || CONFIG_URLS.dev;
const CACHE_KEY = 'matou_client_config';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export interface WitnessConfig {
  urls: string[];
  aids: Record<string, string>;
  oobis: string[];
}

export interface AnySyncNode {
  peerId: string;
  addresses: string[];
  types: string[];
}

export interface AnySyncConfig {
  id: string;
  networkId: string;
  nodes: AnySyncNode[];
}

export interface ClientConfig {
  version: string;
  // 1.0 fields. On an IDSS gateway serving the 1.1 community backend
  // descriptor (ADR 0226) these base blocks are absent — the document carries
  // the additive 1.1 blocks below instead — so every one is optional and every
  // consumer guards it.
  mode?: string;
  keri?: {
    admin_url: string;
    boot_url: string;
    cesr_url: string;
    // Public CESR base for building OOBI URLs that KERIA resolves
    // server-side. Present when the backend serves loopback-proxied KERI
    // URLs to the Capacitor WebView (#368): cesr_url then points at the
    // proxy (for direct fetches) and this keeps the network-reachable base.
    cesr_public_url?: string;
  };
  schema_server_url?: string;
  config_server_url?: string;
  witnesses?: WitnessConfig;
  // anysync is served ONLY when any-sync is installed on the gateway (ADR 0226
  // decision 8); a Coa-built wallet against a content-less IDSS backend simply
  // has no content layer, so it is optional and its absence is inert.
  anysync?: AnySyncConfig;

  // 1.1 community backend descriptor blocks (ADR 0226, amended 0235/0236).
  // Read by the descriptor loader (see ./descriptor). All optional: a 1.0
  // config server omits them, and on a 1.1 document `app` and `doorkeeper` may
  // still be absent.
  backend_kind?: string;
  community?: DescriptorCommunity;
  admins?: DescriptorSteward[];
  api_url?: string;
  schemas?: Record<string, DescriptorSchema>;
  boot?: DescriptorBoot;
  signin?: DescriptorSignin;
  stack?: DescriptorStack;
  app?: DescriptorApp;
}

interface CachedConfig {
  config: ClientConfig;
  timestamp: number;
}

let cachedConfig: CachedConfig | null = null;
let fetchPromise: Promise<ClientConfig> | null = null;

/**
 * Get the config server URL for the current environment
 */
export function getConfigUrl(): string {
  return CONFIG_URL;
}

/**
 * Get current environment
 */
export function getEnv(): string {
  return ENV;
}

/**
 * Fetch client configuration from the config server
 * Caches the result in memory and secure storage
 */
export async function fetchClientConfig(): Promise<ClientConfig> {
  // Return cached if fresh
  if (cachedConfig && Date.now() - cachedConfig.timestamp < CACHE_TTL) {
    return cachedConfig.config;
  }

  // Deduplicate concurrent fetches
  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = doFetchConfig();
  try {
    return await fetchPromise;
  } finally {
    fetchPromise = null;
  }
}

/**
 * Resolve where the client config is fetched from for the current platform.
 *
 * On Capacitor (Android) the WebView's cleartext-network policy only allows
 * plain HTTP to 127.0.0.1/localhost, so a direct request to the plain-HTTP
 * config server is blocked. The embedded Go backend is not subject to that
 * policy and already fetches the same config at startup, exposing it over the
 * loopback API, so we source it from there instead — keeping the loopback-only
 * cleartext policy intact (issue #99).
 *
 * Electron and browser builds are unaffected: they keep hitting the remote
 * config server directly.
 */
async function resolveConfigFetchUrl(): Promise<string> {
  if (isCapacitor()) {
    const backendUrl = await getBackendUrl();
    return `${backendUrl}/api/v1/client-config`;
  }
  return `${CONFIG_URL}/api/client-config`;
}

async function doFetchConfig(): Promise<ClientConfig> {
  try {
    const url = await resolveConfigFetchUrl();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Config server returned ${response.status}`);
    }

    const config = await response.json() as ClientConfig;

    // Validate the community backend descriptor. This refuses ONLY an unknown
    // `version` major (ADR 0226 decision 5) — every absent optional block
    // (anysync, app, the retired doorkeeper) is tolerated. The refusal must
    // propagate so the wallet does not silently fall back to a cached/default
    // config for a document it cannot understand; a `stack` mismatch is a
    // diagnostics warning, never a refusal, so it never reaches here.
    parseDescriptor(config);

    // Cache in memory
    cachedConfig = { config, timestamp: Date.now() };

    // Cache in secure storage for offline fallback
    await secureStorage.setItem(CACHE_KEY, JSON.stringify(cachedConfig));

    console.log(`[ClientConfig] Fetched config for ${config.mode} environment`);
    return config;
  } catch (err) {
    // An unknown descriptor major is a hard refusal (ADR 0226 decision 5): the
    // wallet cannot understand the document, and falling back to a cached or
    // default config would silently pretend it can. Propagate it.
    if (err instanceof UnsupportedDescriptorVersionError) {
      throw err;
    }
    console.warn('[ClientConfig] Failed to fetch, trying cache:', err);

    // Try secure storage cache
    const cached = await loadCachedConfig();
    if (cached) {
      console.log('[ClientConfig] Using cached config');
      return cached;
    }

    // Return defaults as last resort
    console.warn('[ClientConfig] No cache available, using defaults');
    return getDefaultConfig();
  }
}

async function loadCachedConfig(): Promise<ClientConfig | null> {
  try {
    const stored = await secureStorage.getItem(CACHE_KEY);
    if (!stored) return null;

    const cached = JSON.parse(stored) as CachedConfig;
    cachedConfig = cached;
    return cached.config;
  } catch {
    return null;
  }
}

function getDefaultConfig(): ClientConfig {
  return {
    version: '1.0',
    mode: 'dev',
    keri: {
      admin_url: 'http://localhost:3901',
      boot_url: 'http://localhost:3903',
      cesr_url: 'http://localhost:3902',
    },
    schema_server_url: 'http://localhost:7723',
    config_server_url: 'http://localhost:3904',
    witnesses: {
      urls: [],
      aids: {},
      oobis: [],
    },
    anysync: {
      id: '',
      networkId: '',
      nodes: [],
    },
  };
}

/**
 * Clear cached config (useful for testing or environment switch)
 */
export async function clearClientConfigCache(): Promise<void> {
  cachedConfig = null;
  await secureStorage.removeItem(CACHE_KEY);
}

/**
 * Get KERIA admin URL
 */
export async function getKeriaAdminUrl(): Promise<string> {
  const config = await fetchClientConfig();
  return config.keri?.admin_url ?? '';
}

/**
 * Get KERIA boot URL
 */
export async function getKeriaBootUrl(): Promise<string> {
  const config = await fetchClientConfig();
  return config.keri?.boot_url ?? '';
}

/**
 * Get KERIA CESR URL
 */
export async function getKeriaCesrUrl(): Promise<string> {
  const config = await fetchClientConfig();
  return config.keri?.cesr_url ?? '';
}

/**
 * Get schema server URL
 */
export async function getSchemaServerUrl(): Promise<string> {
  const config = await fetchClientConfig();
  return config.schema_server_url ?? '';
}

/**
 * Get witness OOBIs
 */
export async function getWitnessOobis(): Promise<string[]> {
  const config = await fetchClientConfig();
  return config.witnesses?.oobis ?? [];
}

/**
 * Get anysync network configuration.
 *
 * On an IDSS gateway without any-sync installed the descriptor carries no
 * `anysync` block (ADR 0226 decision 8); the content layer is simply absent
 * and this returns an empty config rather than throwing.
 */
export async function getAnySyncConfig(): Promise<AnySyncConfig> {
  const config = await fetchClientConfig();
  return config.anysync ?? { id: '', networkId: '', nodes: [] };
}

/** True once any-sync is installed on the gateway (the content layer exists). */
export async function hasContentLayer(): Promise<boolean> {
  const config = await fetchClientConfig();
  return !!config.anysync && config.anysync.nodes.length > 0;
}

/**
 * The parsed community backend descriptor (ADR 0226). Refuses only an unknown
 * `version` major; tolerates every absent optional block.
 */
export async function getCommunityDescriptor(): Promise<CommunityDescriptor> {
  const config = await fetchClientConfig();
  return parseDescriptor(config);
}

/**
 * The schema OOBIs the wallet resolves, taken from the descriptor's `schemas`
 * block rather than a built-in list (ADR 0226 decision 5). Empty on a 1.0
 * config server that serves no `schemas` block.
 */
export async function getSchemaOobis(): Promise<string[]> {
  const config = await fetchClientConfig();
  return descriptorSchemaOobis(parseDescriptor(config));
}

/**
 * The OOBI for one credential kind (e.g. `membership`, `committee`) from the
 * descriptor's `schemas` block, or undefined when the document names none.
 */
export async function getSchemaOobi(kind: string): Promise<string | undefined> {
  const config = await fetchClientConfig();
  return config.schemas?.[kind]?.oobi;
}

/**
 * The Membership schema SAID this community issues under (issue #615): the one
 * the descriptor names in `schemas.membership.said`, falling back to the Mātou
 * constant only for a descriptor with no `schemas` block (coa-shared). Every
 * membership check reads this so a correctly issued IDSS credential — of the
 * community's OWN schema — is recognised as membership.
 */
export async function getMembershipSchemaSaid(): Promise<string> {
  const config = await fetchClientConfig();
  return descriptorMembershipSchemaSaid(parseDescriptor(config));
}

/**
 * The community group AID the descriptor names (`community.aid`), the issuer of
 * every credential on an IDSS community; empty when the document names none.
 */
export async function getCommunityAid(): Promise<string> {
  const config = await fetchClientConfig();
  return parseDescriptor(config).community?.aid ?? '';
}

/**
 * The Membership schema OOBI from the descriptor's `schemas` block, or
 * undefined when the document names none (a coa-shared backend).
 */
export async function getMembershipSchemaOobi(): Promise<string | undefined> {
  const config = await fetchClientConfig();
  return descriptorMembershipSchemaOobi(parseDescriptor(config));
}

/**
 * The home community's sign-in door, pre-trusted from the baked descriptor
 * (ADR 0236). Consumed by the wallet's known-doors list (#1492).
 */
export async function getSigninUrl(): Promise<string | undefined> {
  const config = await fetchClientConfig();
  return descriptorSigninUrl(parseDescriptor(config));
}
