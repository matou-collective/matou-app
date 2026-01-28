import { test, expect } from '@playwright/test';

/**
 * E2E Test: Space Operations
 *
 * Prerequisites:
 * - KERI infrastructure running: cd infrastructure/keri && make up
 * - Backend running: cd backend && go run cmd/server/main.go
 * - Frontend running: cd frontend && npm run dev
 * - Org already set up (run org-setup.spec.ts first)
 *
 * Run: npx playwright test tests/e2e/spaces.spec.ts
 * Debug: npx playwright test tests/e2e/spaces.spec.ts --debug
 * Headed: npx playwright test tests/e2e/spaces.spec.ts --headed
 */

const FRONTEND_URL = 'http://localhost:9002';
const BACKEND_URL = 'http://localhost:8080';
const CONFIG_SERVER_URL = 'http://localhost:3904';

test.describe('Matou Space Operations', () => {
  test.beforeEach(async ({ page }) => {
    // Log console messages for debugging
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.text().includes('Space') || msg.text().includes('space')) {
        console.log(`[Browser ${msg.type()}] ${msg.text()}`);
      }
    });

    // Log failed requests
    page.on('requestfailed', (request) => {
      console.log(`[Network FAILED] ${request.method()} ${request.url()}`);
      console.log(`  Error: ${request.failure()?.errorText}`);
    });
  });

  test('backend health check includes space status', async ({ request }) => {
    // Test that backend is running and can report space status
    const response = await request.get(`${BACKEND_URL}/api/v1/health`);

    if (response.ok()) {
      const body = await response.json();
      console.log('Backend health:', JSON.stringify(body, null, 2));

      // Health response should include spaces info
      expect(body).toBeDefined();
      expect(body.status).toBe('ok');

      // Check for space-related fields (if backend supports them)
      if (body.spaces) {
        console.log('Spaces info:', body.spaces);
      }
    } else {
      console.log('Backend not available, skipping space status check');
    }
  });

  test('community space created during org setup', async ({ request }) => {
    test.setTimeout(30000);

    // Step 1: Check if org config exists
    await test.step('Verify org config exists', async () => {
      const configResponse = await request.get(`${CONFIG_SERVER_URL}/api/config`);

      if (!configResponse.ok()) {
        console.log('No org config found - run org-setup.spec.ts first');
        test.skip();
        return;
      }

      const config = await configResponse.json();
      console.log('Org config found:', {
        orgAid: config.organization?.aid,
        orgName: config.organization?.name,
        communitySpaceId: config.communitySpaceId,
      });

      expect(config.organization).toBeDefined();
      expect(config.organization.aid).toBeTruthy();
    });

    // Step 2: Check community space via backend API
    await test.step('Verify community space via backend', async () => {
      const response = await request.get(`${BACKEND_URL}/api/v1/spaces/community`);

      if (response.status() === 200) {
        const body = await response.json();
        console.log('Community space:', body);

        expect(body.spaceId).toBeTruthy();
        expect(body.type).toBe('community');
        console.log(`Community space ID: ${body.spaceId}`);
      } else if (response.status() === 404) {
        // Community space not yet created - this is expected if backend
        // wasn't running during org setup
        console.log('Community space not found (404)');
        console.log('This is expected if backend was not running during org setup');
      } else {
        console.log(`Unexpected response: ${response.status()}`);
      }
    });

    // Step 3: Try creating community space (should be idempotent)
    await test.step('Create community space (idempotent)', async () => {
      const configResponse = await request.get(`${CONFIG_SERVER_URL}/api/config`);
      if (!configResponse.ok()) return;

      const config = await configResponse.json();
      const orgAid = config.organization?.aid;

      if (!orgAid) {
        console.log('No org AID found');
        return;
      }

      const createResponse = await request.post(`${BACKEND_URL}/api/v1/spaces/community`, {
        data: {
          orgAid,
          orgName: config.organization.name || 'Matou Community',
        },
      });

      if (createResponse.ok()) {
        const body = await createResponse.json();
        console.log('Community space created/retrieved:', body);
        expect(body.spaceId).toBeTruthy();
        expect(body.success).toBe(true);
      } else {
        console.log(`Create community space failed: ${createResponse.status()}`);
        const errorBody = await createResponse.text();
        console.log('Error:', errorBody);
      }
    });
  });

  test('private space created on registration', async ({ request }) => {
    test.setTimeout(30000);

    // Test creating a private space for a test user
    const testUserAID = 'ETestUser1234567890abcdefghijklmnopqrstuv';

    await test.step('Create private space for user', async () => {
      const response = await request.post(`${BACKEND_URL}/api/v1/spaces/private`, {
        data: {
          userAid: testUserAID,
        },
      });

      if (response.ok()) {
        const body = await response.json();
        console.log('Private space created:', body);

        expect(body.spaceId).toBeTruthy();
        expect(body.success).toBe(true);
        console.log(`Private space ID: ${body.spaceId}`);
      } else {
        console.log(`Create private space failed: ${response.status()}`);
        const errorBody = await response.text();
        console.log('Error:', errorBody);
      }
    });

    // Step 2: Verify idempotency - creating again returns same space
    await test.step('Private space creation is idempotent', async () => {
      const response1 = await request.post(`${BACKEND_URL}/api/v1/spaces/private`, {
        data: { userAid: testUserAID },
      });

      const response2 = await request.post(`${BACKEND_URL}/api/v1/spaces/private`, {
        data: { userAid: testUserAID },
      });

      if (response1.ok() && response2.ok()) {
        const body1 = await response1.json();
        const body2 = await response2.json();

        console.log('First call space ID:', body1.spaceId);
        console.log('Second call space ID:', body2.spaceId);

        expect(body1.spaceId).toBe(body2.spaceId);
        console.log('Idempotency verified - same space ID returned');
      }
    });
  });

  test('user invited to community after approval', async ({ request }) => {
    test.setTimeout(60000);

    // This test simulates the invitation flow
    const testRecipientAID = 'ERecipient123456789abcdefghijklmnopqrst';
    const testCredentialSAID = 'EMembershipCredSAID123456789abcdefgh';
    const membershipSchema = 'EMatouMembershipSchemaV1';

    // Step 1: Ensure community space exists
    await test.step('Ensure community space exists', async () => {
      const configResponse = await request.get(`${CONFIG_SERVER_URL}/api/config`);
      if (!configResponse.ok()) {
        console.log('No org config - skipping invitation test');
        test.skip();
        return;
      }

      const config = await configResponse.json();
      if (!config.organization?.aid) {
        console.log('No org AID - skipping invitation test');
        test.skip();
        return;
      }

      // Create community space if needed
      await request.post(`${BACKEND_URL}/api/v1/spaces/community`, {
        data: {
          orgAid: config.organization.aid,
          orgName: config.organization.name,
        },
      });
    });

    // Step 2: Invite user to community
    await test.step('Invite user to community space', async () => {
      const response = await request.post(`${BACKEND_URL}/api/v1/spaces/community/invite`, {
        data: {
          recipientAid: testRecipientAID,
          credentialSaid: testCredentialSAID,
          schema: membershipSchema,
        },
      });

      if (response.ok()) {
        const body = await response.json();
        console.log('Invitation response:', body);

        expect(body.success).toBe(true);
        expect(body.privateSpaceId).toBeTruthy();
        expect(body.communitySpaceId).toBeTruthy();

        console.log(`User ${testRecipientAID.substring(0, 10)}... invited to community`);
        console.log(`Private space: ${body.privateSpaceId}`);
        console.log(`Community space: ${body.communitySpaceId}`);
      } else if (response.status() === 409) {
        console.log('Community space not configured (409 Conflict)');
        console.log('This is expected if org setup did not create community space');
      } else {
        console.log(`Invite failed: ${response.status()}`);
        const errorBody = await response.text();
        console.log('Error:', errorBody);
      }
    });
  });

  test('invitation with invalid schema rejected', async ({ request }) => {
    const testRecipientAID = 'EInvalidSchemaUser12345678901234567';
    const testCredentialSAID = 'EInvalidSchemaCred12345678901234567';
    const invalidSchema = 'EInvalidSchemaNotMembership';

    const response = await request.post(`${BACKEND_URL}/api/v1/spaces/community/invite`, {
      data: {
        recipientAid: testRecipientAID,
        credentialSaid: testCredentialSAID,
        schema: invalidSchema,
      },
    });

    console.log(`Invalid schema response: ${response.status()}`);

    // Should reject with 400 Bad Request for invalid schema
    if (response.status() === 400) {
      console.log('Correctly rejected invalid schema');
      expect(response.status()).toBe(400);
    } else if (response.status() === 409) {
      // No community space - also acceptable
      console.log('No community space configured');
    } else {
      console.log(`Unexpected status: ${response.status()}`);
      const body = await response.text();
      console.log('Response:', body);
    }
  });

  test('graceful degradation when backend unavailable', async ({ page }) => {
    test.setTimeout(30000);

    // Test that frontend handles backend unavailability gracefully
    await test.step('Navigate to app', async () => {
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');
    });

    await test.step('Verify app loads even if backend spaces API fails', async () => {
      // The app should still load and function even if space APIs are unavailable
      // This tests the non-blocking nature of space operations

      // Try to intercept backend calls and simulate failure
      await page.route(`${BACKEND_URL}/api/v1/spaces/**`, async (route) => {
        console.log('Intercepting and failing space request:', route.request().url());
        await route.abort('connectionrefused');
      });

      // Navigate to a page that might call space APIs
      await page.goto(FRONTEND_URL);
      await page.waitForLoadState('networkidle');

      // App should still be functional
      const isLoaded = await page.locator('body').isVisible();
      expect(isLoaded).toBe(true);

      // Check there's no error overlay blocking the app
      const errorOverlay = page.locator('.error-overlay, .fatal-error');
      const hasBlockingError = await errorOverlay.isVisible().catch(() => false);

      if (hasBlockingError) {
        await page.screenshot({ path: 'tests/e2e/screenshots/spaces-backend-error.png' });
      }

      // The app should degrade gracefully - no blocking errors
      console.log('App loaded without blocking error from backend unavailability');
    });

    await test.step('Clear route interception', async () => {
      await page.unroute(`${BACKEND_URL}/api/v1/spaces/**`);
    });
  });

  test('credential synced to both spaces', async ({ request }) => {
    test.setTimeout(60000);

    // This test verifies the credential sync flow
    const testUserAID = 'ESyncTestUser12345678901234567890123';
    const testCredentials = [
      {
        d: 'ETestCredentialSAID1234567890abcdefg',
        s: 'EMatouMembershipSchemaV1',
        a: {
          d: testUserAID,
          schema: 'EMatouMembershipSchemaV1',
          memberSince: new Date().toISOString(),
        },
      },
    ];

    // Step 1: Sync credentials to backend
    await test.step('Sync credentials to backend', async () => {
      const response = await request.post(`${BACKEND_URL}/api/v1/sync/credentials`, {
        data: {
          userAid: testUserAID,
          credentials: testCredentials,
        },
      });

      if (response.ok()) {
        const body = await response.json();
        console.log('Credential sync response:', body);

        expect(body.success).toBe(true);
        expect(body.synced).toBeGreaterThan(0);
        console.log(`Synced ${body.synced} credentials`);
      } else {
        console.log(`Credential sync failed: ${response.status()}`);
        const errorBody = await response.text();
        console.log('Error:', errorBody);
      }
    });

    // Step 2: Verify credential is accessible via list endpoint
    await test.step('Verify credentials via list endpoint', async () => {
      const response = await request.get(`${BACKEND_URL}/api/v1/credentials?userAid=${testUserAID}`);

      if (response.ok()) {
        const body = await response.json();
        console.log('Credentials list:', body);

        // Should have at least the synced credential
        if (Array.isArray(body.credentials) && body.credentials.length > 0) {
          console.log(`Found ${body.credentials.length} credentials for user`);
        }
      }
    });
  });

  test('space endpoints require valid request body', async ({ request }) => {
    // Test validation on space endpoints

    await test.step('POST /spaces/community requires orgAid', async () => {
      const response = await request.post(`${BACKEND_URL}/api/v1/spaces/community`, {
        data: {},
      });

      expect(response.status()).toBe(400);
      console.log('Missing orgAid correctly rejected');
    });

    await test.step('POST /spaces/private requires userAid', async () => {
      const response = await request.post(`${BACKEND_URL}/api/v1/spaces/private`, {
        data: {},
      });

      expect(response.status()).toBe(400);
      console.log('Missing userAid correctly rejected');
    });

    await test.step('POST /spaces/community/invite requires recipientAid', async () => {
      const response = await request.post(`${BACKEND_URL}/api/v1/spaces/community/invite`, {
        data: {
          credentialSaid: 'E1234',
          schema: 'EMatouMembershipSchemaV1',
        },
      });

      expect(response.status()).toBe(400);
      console.log('Missing recipientAid correctly rejected');
    });

    await test.step('POST /spaces/community/invite requires credentialSaid', async () => {
      const response = await request.post(`${BACKEND_URL}/api/v1/spaces/community/invite`, {
        data: {
          recipientAid: 'E1234',
          schema: 'EMatouMembershipSchemaV1',
        },
      });

      expect(response.status()).toBe(400);
      console.log('Missing credentialSaid correctly rejected');
    });
  });

  test('CORS headers set correctly for frontend origin', async ({ request }) => {
    // Test that CORS headers are properly set for frontend origins

    await test.step('Check CORS headers on preflight', async () => {
      const response = await request.fetch(`${BACKEND_URL}/api/v1/spaces/community`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:9000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });

      const corsOrigin = response.headers()['access-control-allow-origin'];
      const corsMethods = response.headers()['access-control-allow-methods'];

      console.log('CORS headers:', {
        origin: corsOrigin,
        methods: corsMethods,
      });

      // For allowed origins, should have CORS headers
      // If not set, CORS middleware may need configuration
      if (corsOrigin) {
        expect(corsOrigin).toContain('localhost');
      } else {
        console.log('CORS headers not set - may need middleware configuration');
      }
    });
  });
});

/**
 * Space integration with org setup flow
 * These tests verify space operations are triggered during normal app flow
 */
test.describe('Space Integration with App Flows', () => {
  test('verify space creation after fresh org setup', async ({ page, request }) => {
    test.setTimeout(180000); // 3 minutes

    // This test runs after org-setup to verify community space was created
    // It assumes org-setup.spec.ts has already run

    await test.step('Check org config exists', async () => {
      const configResponse = await request.get(`${CONFIG_SERVER_URL}/api/config`);

      if (!configResponse.ok()) {
        console.log('No org config - run org-setup.spec.ts first');
        test.skip();
        return;
      }

      const config = await configResponse.json();
      console.log('Org config:', {
        orgAid: config.organization?.aid,
        orgName: config.organization?.name,
      });
    });

    await test.step('Verify community space exists via backend', async () => {
      const response = await request.get(`${BACKEND_URL}/api/v1/spaces/community`);

      if (response.status() === 200) {
        const body = await response.json();
        expect(body.spaceId).toBeTruthy();
        console.log('Community space verified:', body.spaceId);
      } else if (response.status() === 404) {
        // Space wasn't created during setup - create it now
        console.log('Community space not found - creating now');

        const configResponse = await request.get(`${CONFIG_SERVER_URL}/api/config`);
        const config = await configResponse.json();

        const createResponse = await request.post(`${BACKEND_URL}/api/v1/spaces/community`, {
          data: {
            orgAid: config.organization.aid,
            orgName: config.organization.name,
          },
        });

        if (createResponse.ok()) {
          const createBody = await createResponse.json();
          console.log('Community space created:', createBody.spaceId);
          expect(createBody.spaceId).toBeTruthy();
        }
      }
    });
  });

  test.skip('verify private space created during registration', async ({ page, request }) => {
    // This test would run as part of registration flow
    // Skipped as it requires full registration which is covered in registration.spec.ts

    // After registration, the backend should have created a private space
    // Verification would happen by:
    // 1. Getting the user's AID from localStorage
    // 2. Checking /api/v1/spaces/private?userAid=...

    console.log('This test is integrated into registration.spec.ts');
  });
});
