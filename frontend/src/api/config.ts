/**
 * Org Config API
 * Fetches org configuration from the config server and caches in secure storage.
 */

import { secureStorage } from 'src/lib/secureStorage';

const CONFIG_SERVER_URL = import.meta.env.VITE_CONFIG_SERVER_URL || 'http://localhost:3904';
const IS_TEST_CONFIG = import.meta.env.VITE_TEST_CONFIG === 'true';
const LOCAL_CACHE_KEY = 'matou_org_config';

/** Build headers for config server requests, adding test isolation header when needed */
function configHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (IS_TEST_CONFIG) {
    headers['X-Test-Config'] = 'true';
  }
  return headers;
}

export interface AdminInfo {
  aid: string;
  name: string;
  oobi?: string;  // Optional OOBI for direct contact
}

export interface OrgConfig {
  organization: {
    aid: string;
    name: string;
    oobi: string;
  };
  admins: AdminInfo[];  // Array of admins (replaces single 'admin')
  // Backward compatibility: old configs may have single 'admin' field
  admin?: {
    aid: string;
    name: string;
  };
  registry?: {
    id: string;
    name: string;
  };
  // any-sync community space ID (created during org setup)
  communitySpaceId?: string;
  // any-sync community read-only space ID
  readOnlySpaceId?: string;
  // any-sync admin space ID
  adminSpaceId?: string;
  generated: string;
}

/**
 * Normalize config to always have 'admins' array
 * Handles backward compatibility with old single 'admin' field
 */
export function normalizeOrgConfig(config: OrgConfig): OrgConfig {
  if (config.admins && config.admins.length > 0) {
    return config;
  }

  // Convert old single admin to admins array
  if (config.admin) {
    return {
      ...config,
      admins: [{ aid: config.admin.aid, name: config.admin.name }],
    };
  }

  // No admins at all
  return { ...config, admins: [] };
}

export type ConfigResult =
  | { status: 'configured'; config: OrgConfig }
  | { status: 'not_configured' }
  | { status: 'server_unreachable'; cached: OrgConfig | null };

/**
 * Fetch org config from server, with localStorage fallback
 *
 * Returns:
 * - { status: 'configured', config } - Server returned config
 * - { status: 'not_configured' } - Server says no org set up yet
 * - { status: 'server_unreachable', cached } - Can't reach server, returns cached config if available
 */
export async function fetchOrgConfig(): Promise<ConfigResult> {
  try {
    const response = await fetch(`${CONFIG_SERVER_URL}/api/config`, {
      signal: AbortSignal.timeout(5000),
      headers: configHeaders(),
    });

    if (response.ok) {
      const rawConfig = await response.json() as OrgConfig;
      // Normalize to ensure admins array exists
      const config = normalizeOrgConfig(rawConfig);
      // Cache to secure storage
      await secureStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(config));
      console.log('[Config] Fetched and cached config for:', config.organization.name);
      return { status: 'configured', config };
    }

    if (response.status === 404) {
      // Server is reachable but no config exists yet
      console.log('[Config] Server reachable but not configured yet');
      return { status: 'not_configured' };
    }

    // Other error - treat as unreachable
    throw new Error(`Server returned ${response.status}`);
  } catch (err) {
    // Server unreachable - check secure storage cache
    console.warn('[Config] Server unreachable:', err);
    const cached = await getCachedConfig();
    return { status: 'server_unreachable', cached };
  }
}

/**
 * Save org config to the server
 * Called after org setup completes
 */
export async function saveOrgConfig(config: OrgConfig): Promise<void> {
  const response = await fetch(`${CONFIG_SERVER_URL}/api/config`, {
    method: 'POST',
    headers: configHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(error.message || `Failed to save config: ${response.status}`);
  }

  // Also cache locally
  await secureStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(config));
  console.log('[Config] Saved config to server and secure storage');
}

/**
 * Get cached config from secure storage
 */
export async function getCachedConfig(): Promise<OrgConfig | null> {
  try {
    const stored = await secureStorage.getItem(LOCAL_CACHE_KEY);
    if (!stored) return null;
    const rawConfig = JSON.parse(stored) as OrgConfig;
    return normalizeOrgConfig(rawConfig);
  } catch {
    return null;
  }
}

/**
 * Clear cached config from secure storage
 */
export async function clearCachedConfig(): Promise<void> {
  await secureStorage.removeItem(LOCAL_CACHE_KEY);
}

/**
 * Check if config server is reachable
 */
export async function isConfigServerReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${CONFIG_SERVER_URL}/api/health`, {
      signal: AbortSignal.timeout(3000),
      headers: configHeaders(),
    });
    return response.ok;
  } catch {
    return false;
  }
}
