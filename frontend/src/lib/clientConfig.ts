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
  mode: string;
  keri: {
    admin_url: string;
    boot_url: string;
    cesr_url: string;
  };
  schema_server_url: string;
  config_server_url: string;
  witnesses: WitnessConfig;
  anysync: AnySyncConfig;
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

async function doFetchConfig(): Promise<ClientConfig> {
  try {
    const response = await fetch(`${CONFIG_URL}/api/client-config`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Config server returned ${response.status}`);
    }

    const config = await response.json() as ClientConfig;

    // Cache in memory
    cachedConfig = { config, timestamp: Date.now() };

    // Cache in secure storage for offline fallback
    await secureStorage.setItem(CACHE_KEY, JSON.stringify(cachedConfig));

    console.log(`[ClientConfig] Fetched config for ${config.mode} environment`);
    return config;
  } catch (err) {
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
  return config.keri.admin_url;
}

/**
 * Get KERIA boot URL
 */
export async function getKeriaBootUrl(): Promise<string> {
  const config = await fetchClientConfig();
  return config.keri.boot_url;
}

/**
 * Get KERIA CESR URL
 */
export async function getKeriaCesrUrl(): Promise<string> {
  const config = await fetchClientConfig();
  return config.keri.cesr_url;
}

/**
 * Get schema server URL
 */
export async function getSchemaServerUrl(): Promise<string> {
  const config = await fetchClientConfig();
  return config.schema_server_url;
}

/**
 * Get witness OOBIs
 */
export async function getWitnessOobis(): Promise<string[]> {
  const config = await fetchClientConfig();
  return config.witnesses.oobis;
}

/**
 * Get anysync network configuration
 */
export async function getAnySyncConfig(): Promise<AnySyncConfig> {
  const config = await fetchClientConfig();
  return config.anysync;
}
