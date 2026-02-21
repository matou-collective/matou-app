import { test, expect, Page, BrowserContext } from '@playwright/test';
import { execSync } from 'child_process';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import { BackendManager } from './utils/backend-manager';
import {
  FRONTEND_URL,
  TIMEOUT,
  setupPageLogging,
  setupBackendRouting,
  registerUser,
  loginWithMnemonic,
  uniqueSuffix,
  loadAccounts,
  performOrgSetup,
  TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Credential Chain Verification — KERIA reger.saved Isolation
 *
 * Reproduces the MissingChainError bug documented in
 * docs/keria-per-agent-credential-isolation.md.
 *
 * When a personal AID agent receives a membership credential via IPEX
 * grant+admit, KERIA stores it in reger.creds but NOT in reger.saved.
 * Issuing a new credential with an edge referencing the membership fails
 * because the verifier checks reger.saved for chain validation.
 *
 * Test structure:
 *   1. Admin is logged in (has membership credential from org setup)
 *   2. Register + approve an applicant (provides a recipient AID)
 *   3. Issue an endorsement credential WITH edge data from the admin's
 *      personal AID — this should fail if reger.saved is empty
 *   4. Issue the same credential WITHOUT edge data — this should succeed
 *   5. Check KERIA logs for MissingChainError
 *
 * Run: npx playwright test --project=credential-chain
 */

// Schema SAIDs
const MEMBERSHIP_SCHEMA_SAID = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT';
const ENDORSEMENT_SCHEMA_SAID = 'EIefouRuIuoi9ZtnW3BOCSVeXQSt8k3uJLvmYHfvNPOE';
// Schema OOBI URL as seen by KERIA inside Docker
const SCHEMA_SERVER_URL = 'http://schema-server:7723';
const ENDORSEMENT_SCHEMA_OOBI = `${SCHEMA_SERVER_URL}/oobi/${ENDORSEMENT_SCHEMA_SAID}`;

/**
 * Get recent MissingChainError entries from KERIA Docker logs.
 * Returns empty string if no errors found or container not accessible.
 */
function getKeriaMissingChainErrors(since?: string): string {
  try {
    const sinceArg = since ? `--since="${since}"` : '';
    return execSync(
      `docker logs matou-keri-test-keria-1 ${sinceArg} 2>&1 | grep -i MissingChainError | tail -20`,
      { encoding: 'utf-8', timeout: 10000 },
    ).trim();
  } catch {
    return '';
  }
}

/**
 * Issue a credential via page.evaluate using the browser's already-connected
 * signify-ts client. Uses Vite's dynamic ESM import to access the KERIClient
 * module singleton.
 *
 * @param page - Playwright page with admin logged in
 * @param params - Credential issuance parameters
 * @returns Result object with success/failure info
 */
async function issueCredentialFromBrowser(
  page: Page,
  params: {
    schemaOOBI: string;
    schemaSAID: string;
    recipientAid: string;
    credentialData: Record<string, unknown>;
    edgeData?: Record<string, unknown>;
    timeoutMs?: number;
  },
): Promise<{
  success: boolean;
  message: string;
  credSaid?: string;
  isTimeout?: boolean;
  error?: string;
}> {
  return page.evaluate(async (p) => {
    try {
      // Access the KERIClient singleton via Vite's ESM module system.
      // In Vite dev mode, source files are served as ES modules and
      // dynamic import() resolves to the same module instance the app uses.
      const keriModule = await import('/src/lib/keri/client.ts');
      const keriClient = keriModule.useKERIClient();
      const client = keriClient.getSignifyClient();
      if (!client) return { success: false, message: 'No signify client connected' };

      // 1. Resolve schema OOBI (may already be resolved)
      try {
        const schemaOp = await client.oobis().resolve(p.schemaOOBI, p.schemaSAID);
        await client.operations().wait(schemaOp, { signal: AbortSignal.timeout(15000) });
      } catch {
        // Schema may already be resolved — continue
      }

      // 2. Find admin's personal AID (not the org AID)
      const aids = await client.identifiers().list();
      const personalAid = aids.aids.find(
        (a: { name: string }) => !a.name.includes('matou-community'),
      );
      if (!personalAid) return { success: false, message: 'No personal AID found' };

      // 3. Get or create endorsement registry
      const registryName = `${personalAid.prefix.slice(0, 12)}-endorsements`;
      let registries = await client.registries().list(personalAid.prefix);
      let registry = registries.find((r: { name: string }) => r.name === registryName);

      if (!registry) {
        console.log('[CredChainTest] Creating endorsement registry...');
        const regResult = await client.registries().create({
          name: personalAid.prefix,
          registryName: registryName,
        });
        const regOp = await regResult.op();
        await client.operations().wait(regOp, { signal: AbortSignal.timeout(60000) });
        registries = await client.registries().list(personalAid.prefix);
        registry = registries.find((r: { name: string }) => r.name === registryName);
      }
      if (!registry) return { success: false, message: 'Could not create registry' };

      // 4. Resolve recipient OOBI if needed
      const cesrUrl = keriClient.getCesrUrl();
      if (cesrUrl && p.recipientAid) {
        try {
          const oobi = `${cesrUrl}/oobi/${p.recipientAid}`;
          const oobiOp = await client.oobis().resolve(oobi);
          await client.operations().wait(oobiOp, { signal: AbortSignal.timeout(30000) });
        } catch {
          // May already be resolved
        }
      }

      // 5. Build credential arguments
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const issueArgs: Record<string, any> = {
        ri: registry.regk,
        s: p.schemaSAID,
        a: {
          i: p.recipientAid,
          ...p.credentialData,
        },
      };

      // Add edge data if provided (this is the key test variable)
      if (p.edgeData) {
        issueArgs.e = p.edgeData;
      }

      // 6. Issue credential
      console.log(`[CredChainTest] Issuing credential (edges: ${!!p.edgeData})...`);
      const credResult = await client.credentials().issue(personalAid.prefix, issueArgs);

      // 7. Wait for operation to complete
      const timeout = p.timeoutMs || 30000;
      await client.operations().wait(credResult.op, {
        signal: AbortSignal.timeout(timeout),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const credSaid = (credResult.acdc as any)?.ked?.d || 'unknown';
      return {
        success: true,
        message: `Credential issued successfully (edges: ${!!p.edgeData})`,
        credSaid,
      };
    } catch (err: unknown) {
      const error = err as Error;
      const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      return {
        success: false,
        message: `Credential issuance failed: ${error.message}`,
        isTimeout,
        error: error.message,
      };
    }
  }, params);
}

test.describe.serial('Credential Chain Verification (KERIA reger.saved isolation)', () => {
  let accounts: TestAccounts;
  let adminContext: BrowserContext;
  let adminPage: Page;
  let applicantAid: string;
  const backends = new BackendManager();

  test.beforeAll(async ({ browser, request }) => {
    await requireAllTestServices();

    // Setup admin context
    adminContext = await browser.newContext();
    await setupTestConfig(adminContext);
    adminPage = await adminContext.newPage();
    setupPageLogging(adminPage, 'Admin');

    // Catch JavaScript errors during app boot
    adminPage.on('pageerror', (error) => {
      console.error(`[Admin PAGE ERROR] ${error.message}`);
    });

    await adminPage.goto(FRONTEND_URL);

    // Wait for Vue to mount — the app may take time to boot
    // (async boot files: initBackendUrl + initKeriConfig + loadOrgConfig)
    const needsSetup = await Promise.race([
      adminPage.waitForURL(/.*#\/setup/, { timeout: TIMEOUT.long }).then(() => true),
      adminPage
        .locator('button', { hasText: /register/i })
        .waitFor({ state: 'visible', timeout: TIMEOUT.long })
        .then(() => false),
      // Also check for the dashboard (admin may auto-restore session)
      adminPage
        .locator('.admin-section, .dashboard-content')
        .first()
        .waitFor({ state: 'visible', timeout: TIMEOUT.long })
        .then(() => false),
    ]);

    if (needsSetup) {
      console.log('[CredChainTest] No org config — running org setup...');
      accounts = await performOrgSetup(adminPage, request);
    } else {
      console.log('[CredChainTest] Org config exists — recovering admin...');
      accounts = loadAccounts();
      if (!accounts.admin?.mnemonic) {
        throw new Error(
          'Org configured but no admin mnemonic found in test-accounts.json.\n' +
            'Either run org-setup first or clean test state and re-run.',
        );
      }
      await loginWithMnemonic(adminPage, accounts.admin.mnemonic);
    }
    console.log('[CredChainTest] Admin ready on dashboard');
  });

  test.afterAll(async () => {
    await backends.stopAll();
    await adminContext?.close();
  });

  // ------------------------------------------------------------------
  // Test 0: Register and approve an applicant to get a recipient AID
  // ------------------------------------------------------------------
  test('setup: register and approve applicant', async ({ browser }) => {
    test.setTimeout(240_000);

    const userBackend = await backends.start('chain-test-user');
    const userContext = await browser.newContext();
    await setupTestConfig(userContext);
    await setupBackendRouting(userContext, userBackend.port);
    const userPage = await userContext.newPage();
    setupPageLogging(userPage, 'ChainTestUser');

    const userName = `ChainTest_${uniqueSuffix()}`;

    try {
      // Register user
      await registerUser(userPage, userName);

      // Wait for admin to see registration
      const registrationCard = adminPage.locator('.registration-card').filter({ hasText: userName });
      await expect(registrationCard).toBeVisible({ timeout: TIMEOUT.registrationSubmit });

      // Admin approves
      await registrationCard.getByRole('button', { name: /approve/i }).click();

      // User receives credential
      await expect(userPage.locator('.welcome-overlay')).toBeVisible({
        timeout: TIMEOUT.long + 30_000,
      });

      // Capture the applicant's AID from the identity store via Vite ESM import
      applicantAid = await userPage.evaluate(async () => {
        try {
          const mod = await import('/src/stores/identity.ts');
          const store = mod.useIdentityStore();
          return store.currentAID?.prefix || '';
        } catch {
          return '';
        }
      });
      expect(applicantAid).toBeTruthy();
      console.log(`[CredChainTest] Applicant AID: ${applicantAid.slice(0, 16)}...`);
    } finally {
      await userContext.close();
      await backends.stop('chain-test-user');
    }
  });

  // ------------------------------------------------------------------
  // Test 1: Verify admin has membership credential in reger.creds
  // ------------------------------------------------------------------
  test('admin has membership credential visible via API', async () => {
    const result = await adminPage.evaluate(async (MEMBERSHIP_SAID) => {
      try {
        const keriModule = await import('/src/lib/keri/client.ts');
        const keriClient = keriModule.useKERIClient();
        const client = keriClient.getSignifyClient();
        if (!client) return { found: false, error: 'No signify client' };

        const creds = await client.credentials().list();
        const membership = creds.find(
          (c: { sad?: { s?: string } }) => c.sad?.s === MEMBERSHIP_SAID,
        );

        return {
          found: !!membership,
          totalCredentials: creds.length,
          membershipSaid: membership?.sad?.d || null,
          membershipSchema: membership?.sad?.s || null,
        };
      } catch (err: unknown) {
        return { found: false, error: (err as Error).message };
      }
    }, MEMBERSHIP_SCHEMA_SAID);

    console.log('[CredChainTest] Membership credential check:', JSON.stringify(result, null, 2));
    expect(result.found, 'Admin should have membership credential in reger.creds').toBe(true);
  });

  // ------------------------------------------------------------------
  // Test 2: Issue endorsement WITH edge data (expected to fail/timeout
  //         if reger.saved doesn't have the membership credential)
  // ------------------------------------------------------------------
  test('endorsement with edge data: chain verification', async () => {
    test.setTimeout(120_000);

    // Get the admin's membership credential SAID for the edge reference
    const membershipSaid = await adminPage.evaluate(async (MEMBERSHIP_SAID) => {
      const keriModule = await import('/src/lib/keri/client.ts');
      const keriClient = keriModule.useKERIClient();
      const client = keriClient.getSignifyClient();
      if (!client) return null;

      const creds = await client.credentials().list();
      const membership = creds.find(
        (c: { sad?: { s?: string } }) => c.sad?.s === MEMBERSHIP_SAID,
      );
      return membership?.sad?.d || null;
    }, MEMBERSHIP_SCHEMA_SAID);

    expect(membershipSaid).toBeTruthy();
    console.log(`[CredChainTest] Membership credential SAID: ${membershipSaid}`);

    // Record timestamp for log filtering
    const logTimestamp = new Date().toISOString();

    // Issue endorsement WITH edge data referencing the membership credential
    console.log('[CredChainTest] Issuing endorsement WITH edge data...');
    const result = await issueCredentialFromBrowser(adminPage, {
      schemaOOBI: ENDORSEMENT_SCHEMA_OOBI,
      schemaSAID: ENDORSEMENT_SCHEMA_SAID,
      recipientAid: applicantAid,
      credentialData: {
        dt: new Date().toISOString(),
        endorsementType: 'membership_endorsement',
        category: 'membership',
        claim: 'Test endorsement with edge data for chain verification',
        confidence: 'high',
      },
      edgeData: {
        d: '', // SAID placeholder — signify-ts computes this
        endorserMembership: {
          n: membershipSaid,
          s: MEMBERSHIP_SCHEMA_SAID,
        },
      },
      timeoutMs: 60_000, // Give it 60s — chain verification failure causes timeout
    });

    console.log('[CredChainTest] Edge credential result:', JSON.stringify(result, null, 2));

    // Check KERIA logs for MissingChainError (the smoking gun)
    // Wait a few seconds for logs to flush
    await adminPage.waitForTimeout(3000);
    const missingChainErrors = getKeriaMissingChainErrors(logTimestamp);

    if (result.success) {
      console.log(
        '[CredChainTest] SURPRISING: Credential with edge SUCCEEDED.',
        'This means reger.saved HAS the membership credential.',
        'The Admitter IS properly populating reger.saved.',
      );
      console.log('[CredChainTest] MissingChainError in logs:', missingChainErrors || 'NONE');
    } else if (result.isTimeout) {
      console.log(
        '[CredChainTest] CONFIRMED: Credential with edge TIMED OUT.',
        'The operation never completed — chain verification failed because',
        'the membership credential is NOT in reger.saved.',
      );
      console.log('[CredChainTest] MissingChainError in logs:');
      console.log(missingChainErrors || '  (none found — may need to check container name)');
    } else {
      console.log('[CredChainTest] UNEXPECTED: Credential failed with non-timeout error.');
      console.log('[CredChainTest] Error:', result.error);
    }

    // Log the findings — don't assert success/failure since we're investigating
    // Instead, log clearly what happened for the developer to evaluate
    console.log('\n' + '='.repeat(60));
    console.log('CREDENTIAL CHAIN VERIFICATION RESULTS');
    console.log('='.repeat(60));
    console.log(`Edge credential issued:  ${result.success ? 'YES' : 'NO'}`);
    console.log(`Timed out:               ${result.isTimeout ? 'YES' : 'NO'}`);
    console.log(`MissingChainError:       ${missingChainErrors ? 'YES' : 'NO'}`);
    console.log('='.repeat(60));

    if (!result.success && result.isTimeout) {
      console.log(
        '\nDIAGNOSIS: The personal AID agent\'s reger.saved does NOT contain',
        'the membership credential. The Admitter either did not run or failed',
        'to populate reger.saved after the IPEX admit.',
      );
    }
  });

  // ------------------------------------------------------------------
  // Test 3: Issue endorsement WITHOUT edge data (control — should succeed)
  // ------------------------------------------------------------------
  test('endorsement without edge data: control test', async () => {
    test.setTimeout(120_000);

    console.log('[CredChainTest] Issuing endorsement WITHOUT edge data (control)...');
    const result = await issueCredentialFromBrowser(adminPage, {
      schemaOOBI: ENDORSEMENT_SCHEMA_OOBI,
      schemaSAID: ENDORSEMENT_SCHEMA_SAID,
      recipientAid: applicantAid,
      credentialData: {
        dt: new Date().toISOString(),
        endorsementType: 'membership_endorsement',
        category: 'membership',
        claim: 'Test endorsement WITHOUT edge data (control)',
        confidence: 'high',
      },
      // No edgeData — should bypass chain verification entirely
      timeoutMs: 60_000,
    });

    console.log('[CredChainTest] No-edge credential result:', JSON.stringify(result, null, 2));
    expect(result.success, 'Credential without edge data should succeed').toBe(true);
  });
});
