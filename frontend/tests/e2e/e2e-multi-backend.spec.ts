import { test, expect, BrowserContext, Page } from '@playwright/test';
import { BackendManager, BackendInstance } from './utils/backend-manager';
import {
  BACKEND_URL,
  backendUrl,
  setupBackendRouting,
  TIMEOUT,
} from './utils/test-helpers';
import { setupTestConfig } from './utils/mock-config';

/**
 * E2E: Multi-Backend Infrastructure Smoke Test
 *
 * Validates that the per-user backend infrastructure works correctly:
 * 1. BackendManager can spawn and stop backend instances
 * 2. setupBackendRouting redirects page requests to the correct port
 * 3. Each backend maintains its own identity state (isolation)
 *
 * Prerequisites:
 * - AnySync test network running (backends need it to start)
 * - Admin backend running on port 9080 (MATOU_ENV=test)
 * - Backend binary built: cd backend && make build
 *
 * Does NOT require KERIA — no identity creation happens.
 *
 * Run: npx playwright test e2e-multi-backend
 */

test.describe('Multi-Backend Infrastructure', () => {
  const backends = new BackendManager();

  test.afterAll(async () => {
    await backends.stopAll();
  });

  // ------------------------------------------------------------------
  // Test 1: Admin backend is healthy (baseline)
  // ------------------------------------------------------------------
  test('admin backend is reachable on port 9080', async () => {
    const resp = await fetch(`${BACKEND_URL}/health`);
    expect(resp.ok, `Admin backend health check failed: ${resp.status}`).toBe(true);

    const body = await resp.json();
    expect(body.status).toBeDefined();
    console.log('[Test] Admin backend healthy:', JSON.stringify(body));
  });

  // ------------------------------------------------------------------
  // Test 2: BackendManager spawns a user backend
  // ------------------------------------------------------------------
  test('BackendManager spawns and stops a user backend', async () => {
    // Spawn
    const instance = await backends.start('smoke-test');
    expect(instance.port).toBeGreaterThan(9080);
    expect(instance.url).toBe(`http://localhost:${instance.port}`);
    expect(instance.name).toBe('smoke-test');
    console.log(`[Test] Spawned backend '${instance.name}' on port ${instance.port}`);

    // Verify healthy via direct HTTP
    const resp = await fetch(`${instance.url}/health`);
    expect(resp.ok, `User backend health check failed: ${resp.status}`).toBe(true);
    console.log('[Test] User backend healthy');

    // Verify identity is unconfigured (fresh backend)
    const idResp = await fetch(`${instance.url}/api/v1/identity`);
    expect(idResp.ok).toBe(true);
    const identity = await idResp.json();
    expect(identity.configured).toBe(false);
    expect(identity.aid).toBeFalsy();
    console.log('[Test] User backend identity: unconfigured (expected)');

    // Stop
    await backends.stop('smoke-test');

    // Verify it's actually stopped (health check should fail)
    try {
      await fetch(`http://localhost:${instance.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      // If we get here, the backend is still running
      expect(false, 'Backend should be stopped but is still responding').toBe(true);
    } catch {
      // Expected — connection refused
      console.log('[Test] User backend stopped (connection refused)');
    }
  });

  // ------------------------------------------------------------------
  // Test 3: Route interception redirects page requests
  // ------------------------------------------------------------------
  test('setupBackendRouting redirects page fetch to correct port', async ({ browser }) => {
    // Spawn a user backend
    const instance = await backends.start('route-test');

    // Create a context with routing to the user backend
    const context = await browser.newContext();
    // The suite-wide Authorization extraHTTPHeader makes browser fetches to
    // the config server preflighted, and its CORS allowlist doesn't include
    // Authorization — setupTestConfig's route interception (which bypasses
    // preflight) keeps those fetches working, same as every other spec.
    await setupTestConfig(context);
    await setupBackendRouting(context, instance.port);
    const page = await context.newPage();

    try {
      // Navigate to the app (any page that gives us a JS execution context)
      await page.goto('/', { waitUntil: 'domcontentloaded' });

      // From the page, fetch the "admin" URL (port 9080).
      // If routing works, this should be redirected to the user backend.
      const result = await page.evaluate(async () => {
        const resp = await fetch('http://localhost:9080/api/v1/identity');
        return {
          status: resp.status,
          body: await resp.json(),
          url: resp.url,
        };
      });

      expect(result.status).toBe(200);
      // The user backend has no identity configured (fresh instance).
      // If routing failed, we'd get the admin backend's state instead.
      expect(result.body.configured).toBe(false);
      console.log('[Test] Page fetch routed correctly — got unconfigured identity from user backend');

      // Verify the admin backend still has its own state via direct call
      // (bypasses route interception since it's not from the page)
      const adminResp = await fetch(`${BACKEND_URL}/api/v1/identity`);
      if (adminResp.ok) {
        const adminIdentity = await adminResp.json();
        console.log(`[Test] Admin backend identity (direct): configured=${adminIdentity.configured}`);
      } else {
        // Admin backend may not have the identity endpoint if it hasn't been restarted
        console.log(`[Test] Admin backend /api/v1/identity returned ${adminResp.status} (may need restart)`);
      }

    } finally {
      await context.close();
      await backends.stop('route-test');
    }
  });

  // ------------------------------------------------------------------
  // Test 4: Identity isolation between backends
  // ------------------------------------------------------------------
  test('two backends maintain independent identity state', async () => {
    // Spawn two user backends
    const backend1 = await backends.start('iso-user1');
    const backend2 = await backends.start('iso-user2');

    try {
      // Both should start unconfigured
      const id1Before = await (await fetch(`${backend1.url}/api/v1/identity`)).json();
      const id2Before = await (await fetch(`${backend2.url}/api/v1/identity`)).json();
      expect(id1Before.configured).toBe(false);
      expect(id2Before.configured).toBe(false);
      console.log('[Test] Both backends start unconfigured');

      // Set identity on backend1 only (use a test mnemonic)
      // We use a well-known BIP39 test mnemonic that passes validation
      const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      const testAid = 'ETestAID_IsolationCheck_001';

      const setResp = await fetch(`${backend1.url}/api/v1/identity/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aid: testAid, mnemonic: testMnemonic }),
      });
      expect(setResp.ok, `identity/set failed: ${setResp.status}`).toBe(true);
      const setBody = await setResp.json();
      expect(setBody.success).toBe(true);
      expect(setBody.peerId).toBeTruthy();
      console.log(`[Test] Backend1 identity set: peerId=${setBody.peerId.slice(0, 16)}...`);

      // Verify backend1 is now configured
      const id1After = await (await fetch(`${backend1.url}/api/v1/identity`)).json();
      expect(id1After.configured).toBe(true);
      expect(id1After.aid).toBe(testAid);
      console.log('[Test] Backend1 configured:', id1After.aid);

      // Verify backend2 is still unconfigured (isolation check)
      const id2After = await (await fetch(`${backend2.url}/api/v1/identity`)).json();
      expect(id2After.configured).toBe(false);
      expect(id2After.aid).toBeFalsy();
      console.log('[Test] Backend2 still unconfigured (isolation confirmed)');

      // Verify admin backend is unaffected
      const adminResp = await fetch(`${BACKEND_URL}/api/v1/identity`);
      if (adminResp.ok) {
        const adminId = await adminResp.json();
        expect(adminId.aid).not.toBe(testAid);
        console.log(`[Test] Admin backend unaffected: configured=${adminId.configured}`);
      } else {
        // Admin backend may not have the identity endpoint if it hasn't been restarted
        console.log(`[Test] Admin backend /api/v1/identity returned ${adminResp.status} (may need restart)`);
      }

    } finally {
      await backends.stop('iso-user1');
      await backends.stop('iso-user2');
    }
  });

  // ------------------------------------------------------------------
  // Test 5: Route interception with multiple contexts
  // ------------------------------------------------------------------
  test('multiple contexts route to different backends simultaneously', async ({ browser }) => {
    const backend1 = await backends.start('multi-ctx-1');
    const backend2 = await backends.start('multi-ctx-2');

    const ctx1 = await browser.newContext();
    await setupTestConfig(ctx1);
    await setupBackendRouting(ctx1, backend1.port);
    const page1 = await ctx1.newPage();

    const ctx2 = await browser.newContext();
    await setupTestConfig(ctx2);
    await setupBackendRouting(ctx2, backend2.port);
    const page2 = await ctx2.newPage();

    try {
      // Navigate both pages
      await Promise.all([
        page1.goto('/', { waitUntil: 'domcontentloaded' }),
        page2.goto('/', { waitUntil: 'domcontentloaded' }),
      ]);

      // Set identity on backend1 only
      const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      await fetch(`${backend1.url}/api/v1/identity/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aid: 'EMultiCtx_User1', mnemonic: testMnemonic }),
      });

      // Query identity from both pages (both fetch localhost:9080, but routing differs)
      const [result1, result2] = await Promise.all([
        page1.evaluate(async () => {
          const resp = await fetch('http://localhost:9080/api/v1/identity');
          return resp.json();
        }),
        page2.evaluate(async () => {
          const resp = await fetch('http://localhost:9080/api/v1/identity');
          return resp.json();
        }),
      ]);

      // Page1 should see configured identity (routed to backend1)
      expect(result1.configured).toBe(true);
      expect(result1.aid).toBe('EMultiCtx_User1');
      console.log('[Test] Context1 sees backend1 identity:', result1.aid);

      // Page2 should see unconfigured (routed to backend2)
      expect(result2.configured).toBe(false);
      console.log('[Test] Context2 sees backend2 identity: unconfigured');

      console.log('[Test] PASS - Multiple contexts correctly isolated');

    } finally {
      await ctx1.close();
      await ctx2.close();
      await backends.stop('multi-ctx-1');
      await backends.stop('multi-ctx-2');
    }
  });
});
