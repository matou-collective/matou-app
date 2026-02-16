/**
 * Org Config API
 * Fetches org configuration from the backend and caches in secure storage.
 *
 * Note: This replaces the separate config server. Config is now served by the
 * backend at /api/v1/org/config. The backend stores config in {dataDir}/org-config.yaml.
 */

import { secureStorage } from 'src/lib/secureStorage';
import { getBackendUrl } from 'src/lib/platform';
import { getConfigUrl, getEnv } from 'src/lib/clientConfig';

// Config server URL from clientConfig (respects VITE_ENV)
const CONFIG_SERVER_URL = getConfigUrl();
const IS_TEST_CONFIG = getEnv() === 'test';
const LOCAL_CACHE_KEY = 'matou_org_config';

/** Build headers for config requests, adding test isolation header when needed */
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
  schema?: {
    said: string;
    oobi: string;
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
 * Fetch org config from backend, with config server fallback and localStorage cache
 *
 * Returns:
 * - { status: 'configured', config } - Server returned config
 * - { status: 'not_configured' } - Server says no org set up yet
 * - { status: 'server_unreachable', cached } - Can't reach server, returns cached config if available
 */
export async function fetchOrgConfig(): Promise<ConfigResult> {
  // Try backend first (new unified endpoint)
  try {
    const backendUrl = await getBackendUrl();
    const response = await fetch(`${backendUrl}/api/v1/org/config`, {
      signal: AbortSignal.timeout(5000),
      headers: configHeaders(),
    });

    if (response.ok) {
      const rawConfig = await response.json() as OrgConfig;
      const config = normalizeOrgConfig(rawConfig);
      await secureStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(config));
      console.log('[Config] Fetched config from backend for:', config.organization.name);
      return { status: 'configured', config };
    }

    if (response.status === 404) {
      console.log('[Config] Backend not configured, trying config server...');
      // Don't return yet - fall through to try config server
    }
  } catch (err) {
    console.warn('[Config] Backend unreachable, trying config server:', err);
  }

  // Try config server (primary source for org config in multi-session dev)
  try {
    const response = await fetch(`${CONFIG_SERVER_URL}/api/config`, {
      signal: AbortSignal.timeout(5000),
      headers: configHeaders(),
    });

    if (response.ok) {
      const rawConfig = await response.json() as OrgConfig;
      const config = normalizeOrgConfig(rawConfig);
      await secureStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(config));
      console.log('[Config] Fetched config from config server for:', config.organization.name);
      return { status: 'configured', config };
    }

    if (response.status === 404) {
      console.log('[Config] Config server reachable but not configured yet');
      return { status: 'not_configured' };
    }

    throw new Error(`Config server returned ${response.status}`);
  } catch (err) {
    // All servers unreachable - check secure storage cache
    console.warn('[Config] All servers unreachable:', err);
    const cached = await getCachedConfig();
    return { status: 'server_unreachable', cached };
  }
}

/**
 * Save org config to both backend and config server
 * Called after org setup completes
 */
export async function saveOrgConfig(config: OrgConfig): Promise<void> {
  const errors: string[] = [];

  // Save to backend (primary)
  try {
    const backendUrl = await getBackendUrl();
    const backendResponse = await fetch(`${backendUrl}/api/v1/org/config`, {
      method: 'POST',
      headers: configHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(config),
    });

    if (!backendResponse.ok) {
      const error = await backendResponse.json().catch(() => ({ message: 'Unknown error' }));
      errors.push(`Backend: ${error.message || backendResponse.status}`);
    } else {
      console.log('[Config] Saved config to backend');
    }
  } catch (err) {
    errors.push(`Backend: ${err instanceof Error ? err.message : 'unreachable'}`);
  }

  // Also save to legacy config server for backward compatibility
  try {
    const response = await fetch(`${CONFIG_SERVER_URL}/api/config`, {
      method: 'POST',
      headers: configHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      errors.push(`Config server: ${error.message || response.status}`);
    } else {
      console.log('[Config] Saved config to config server');
    }
  } catch (err) {
    // Config server failure is not critical if backend succeeded
    console.warn('[Config] Config server save failed:', err);
  }

  // Cache locally regardless
  await secureStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(config));
  console.log('[Config] Cached config in secure storage');

  // If both failed, throw error
  if (errors.length === 2) {
    throw new Error(`Failed to save config: ${errors.join('; ')}`);
  }
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
 * Check if config service is reachable (backend or config server)
 */
export async function isConfigServerReachable(): Promise<boolean> {
  // Try backend first
  try {
    const backendUrl = await getBackendUrl();
    const response = await fetch(`${backendUrl}/api/v1/org/health`, {
      signal: AbortSignal.timeout(3000),
      headers: configHeaders(),
    });
    if (response.ok) return true;
  } catch {
    // Backend not reachable, try config server
  }

  // Fallback to legacy config server
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
