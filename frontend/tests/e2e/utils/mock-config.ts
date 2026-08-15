/**
 * Test utilities for isolating test config from development config
 *
 * Uses Playwright's route interception to add X-Test-Config header
 * to all config server requests, making them use a separate test config file.
 */
import { Page, BrowserContext, APIRequestContext } from '@playwright/test';
import { keriEndpoints, backendEndpoint, configAdminToken } from './keri-testnet';

// The app reads VITE_CONFIG_SERVER_URL from env (.env.test sets it to port 4904).
// We intercept browser requests to add X-Test-Config header so the config server
// uses a separate test config file (/data/test-org-config.json).
const CONFIG_SERVER_URL = keriEndpoints.configURL;
const BACKEND_URL = backendEndpoint;

/**
 * Setup test config isolation for a page or context
 *
 * This intercepts all requests to the config server and adds the
 * X-Test-Config: true header, causing the server to use a separate
 * test config file (/data/test-org-config.json).
 *
 * @param target - Page or BrowserContext to setup
 */
export async function setupTestConfig(target: Page | BrowserContext) {
  // Intercept config server requests and add X-Test-Config header
  // so the server uses the test config file instead of the dev one.
  await target.route(`${CONFIG_SERVER_URL}/**`, async (route, request) => {
    const headers = {
      ...request.headers(),
      'X-Test-Config': 'true',
    };
    await route.continue({ headers });
  });
}

/**
 * Clear the test config via API request
 * Clears both the config server and the backend's org-config.yaml
 *
 * @param request - Playwright APIRequestContext
 */
export async function clearTestConfig(request: APIRequestContext) {
  // Clear config server. DELETE is bearer-gated (see matou-collective/
  // matou-app#1): use the token from the environment when one is provided
  // (pr-e2e sources it from the infra checkout), else the well-known
  // dev/test placeholder.
  try {
    const resp = await request.delete(`${CONFIG_SERVER_URL}/api/config`, {
      headers: {
        'X-Test-Config': 'true',
        Authorization: `Bearer ${process.env.CONFIG_ADMIN_TOKEN || configAdminToken}`,
      },
    });
    // request.delete does not throw on non-2xx: a 401 (token mismatch) would
    // otherwise log success while stale config survives into the next run.
    if (resp.ok() || resp.status() === 404) {
      console.log('[TestConfig] Cleared config server');
    } else {
      console.warn(`[TestConfig] Config server clear failed: ${resp.status()}`);
    }
  } catch {
    console.log('[TestConfig] No config server config to clear');
  }

  // Clear backend org config
  try {
    const resp = await request.delete(`${BACKEND_URL}/api/v1/org/config`);
    if (resp.ok() || resp.status() === 404) {
      console.log('[TestConfig] Cleared backend org config');
    } else {
      console.warn(`[TestConfig] Backend org config clear failed: ${resp.status()}`);
    }
  } catch {
    console.log('[TestConfig] No backend org config to clear');
  }
}

/**
 * Check if test config exists via API request
 *
 * @param request - Playwright APIRequestContext
 */
export async function hasTestConfig(request: APIRequestContext): Promise<boolean> {
  try {
    const response = await request.get(`${CONFIG_SERVER_URL}/api/health`, {
      headers: { 'X-Test-Config': 'true' },
    });
    const data = await response.json();
    return data.configured === true;
  } catch {
    return false;
  }
}

/**
 * Get the test config via API request
 *
 * @param request - Playwright APIRequestContext
 */
export async function getTestConfig(request: APIRequestContext) {
  const response = await request.get(`${CONFIG_SERVER_URL}/api/config`, {
    headers: { 'X-Test-Config': 'true' },
  });
  if (response.ok()) {
    return await response.json();
  }
  return null;
}
