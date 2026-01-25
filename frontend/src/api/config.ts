/**
 * Org Config API
 * Fetches org configuration from the config server and caches in localStorage.
 */

const CONFIG_SERVER_URL = 'http://localhost:3904';
const LOCAL_CACHE_KEY = 'matou_org_config';

export interface OrgConfig {
  organization: {
    aid: string;
    name: string;
    oobi: string;
  };
  admin: {
    aid: string;
    name: string;
  };
  registry?: {
    id: string;
    name: string;
  };
  generated: string;
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
    });

    if (response.ok) {
      const config = await response.json() as OrgConfig;
      // Cache to localStorage
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(config));
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
    // Server unreachable - check localStorage cache
    console.warn('[Config] Server unreachable:', err);
    const cached = getCachedConfig();
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(error.message || `Failed to save config: ${response.status}`);
  }

  // Also cache locally
  localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(config));
  console.log('[Config] Saved config to server and localStorage');
}

/**
 * Get cached config from localStorage (synchronous)
 */
export function getCachedConfig(): OrgConfig | null {
  try {
    const stored = localStorage.getItem(LOCAL_CACHE_KEY);
    if (!stored) return null;
    return JSON.parse(stored) as OrgConfig;
  } catch {
    return null;
  }
}

/**
 * Clear cached config from localStorage
 */
export function clearCachedConfig(): void {
  localStorage.removeItem(LOCAL_CACHE_KEY);
}

/**
 * Check if config server is reachable
 */
export async function isConfigServerReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${CONFIG_SERVER_URL}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
