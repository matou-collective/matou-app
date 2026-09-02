import { defineConfig, devices } from '@playwright/test';
// Side-effect import: patches Node's global fetch to attach the dev API token
// to local backend /api/ requests. extraHTTPHeaders below covers browser and
// `request`-fixture calls; this covers specs that use Node's global fetch
// directly (e.g. e2e-multi-backend identity/set, feature-spec seeding).
import './tests/e2e/utils/node-fetch-auth';

// Test dev server port (separate from dev server on 9002)
const TEST_SERVER_PORT = 9003;

// Shared browser config
const browserConfig = {
  ...devices['Desktop Chrome'],
  headless: !process.env.HEADED,
  launchOptions: {
    slowMo: process.env.HEADED ? 100 : 0,
    args: [
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--allow-running-insecure-content',
    ],
  },
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Run tests sequentially for this flow
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  // Per-test budget — a single cap rather than a stack of per-action timeouts.
  // When this fires Playwright cancels *all* pending waits in the test, so a
  // stuck phase aborts immediately instead of crawling through compounded
  // action timeouts. Individual test()s that legitimately need more (org
  // setup, AID creation, steward upgrade) override via test.setTimeout(N).
  // 3 min covers most cross-session sync phases; beforeAll hooks that run
  // full org setup + member registration already call test.setTimeout(360_000).
  timeout: 180_000,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: `http://localhost:${TEST_SERVER_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'on',
    video: 'on-first-retry',
    // Backend TokenGuard requires an API token on mutating requests. Test
    // backends fall back to the fixed dev token, so inject it centrally here so
    // both app-driven fetches and direct page.request calls are authenticated.
    //
    // CAVEAT: context-level extra headers participate in CORS — they make
    // every cross-origin browser fetch preflighted, and the config server's
    // allowlist must include Authorization or fetches to it fail ("Failed to
    // fetch") and the app silently falls back to dev-infra defaults. Specs
    // are safe when they use setupTestConfig() (its route interception
    // bypasses preflight); any context that skips it must add it. The durable
    // fix — Authorization in the config server's Access-Control-Allow-Headers
    // — ships with matou-infrastructure feat/config-server-auth.
    // NOTE: this header is for the `request` fixture only. Browser contexts
    // that go through setupTestConfig() clear it again (it would otherwise
    // override the app's own session token and 401 under signed-auth
    // enforcement — see setupTestConfig in tests/e2e/utils/mock-config.ts).
    extraHTTPHeaders: {
      Authorization: 'Bearer matou-dev',
    },
  },

  projects: [
    // Org setup must run first - creates the organization
    {
      name: 'org-setup',
      testMatch: /e2e-org-setup\.spec\.ts/,
      use: browserConfig,
    },
    // Registration tests - uses persisted test config from org-setup
    // No dependency — self-sufficient (auto-runs org-setup if needed)
    {
      name: 'registration',
      testMatch: /e2e-registration\.spec\.ts/,
      use: browserConfig,
    },
    // Bootstrap-only slice of registration for the features project: just the
    // admin-approves flow that persists accounts.member. Keeps feature e2e
    // independent of the steward-upgrade path (test 2), which is blocked on a
    // known group-issuance TEL gap and would otherwise stop feature specs
    // from ever running.
    {
      name: 'registration-member',
      testMatch: /e2e-registration\.spec\.ts/,
      grep: /admin approves user registration/,
      // Explicit edge (#282): as a bare sibling in features' dependencies,
      // Playwright may schedule this BEFORE org-setup — the spec then org-sets-up
      // through the UI, and a mid-setup failure strands retries at
      // ENOENT test-accounts.json. org-setup first, always.
      dependencies: ['org-setup'],
      use: browserConfig,
    },
    // Invitation tests depend on org existing
    {
      name: 'invitation',
      testMatch: /e2e-invitation\.spec\.ts/,
      use: browserConfig,
    },
    // Multi-backend infrastructure smoke test
    {
      name: 'multi-backend',
      testMatch: /e2e-multi-backend\.spec\.ts/,
      use: browserConfig,
    },
    // Wallet page - credential views, governance, tokens
    {
      name: 'wallet',
      testMatch: /e2e-wallet\.spec\.ts/,
      use: browserConfig,
    },
    // Activity page - notice board, events, updates, interactions
    {
      name: 'activity',
      testMatch: /e2e-activity\.spec\.ts/,
      use: browserConfig,
    },
    // Account recovery - verifies full space access recovery from mnemonic
    {
      name: 'account-recovery',
      testMatch: /e2e-account-recovery\.spec\.ts/,
      use: browserConfig,
    },
    // Recovery & error handling - independent
    {
      name: 'recovery-errors',
      testMatch: /e2e-recovery-errors\.spec\.ts/,
      use: browserConfig,
    },
    // KERIA stress test - concurrent registrations with admin processing
    {
      name: 'stress',
      testMatch: /e2e-keria-stress\.spec\.ts/,
      use: browserConfig,
      dependencies: ['org-setup'],
    },
    // Chat feature - full integration with real backend and any-sync P2P
    // No dependency — requires test-accounts.json from registration
    {
      name: 'chat',
      testMatch: /e2e-chat\.spec\.ts/,
      use: browserConfig,
    },
    // Credential chain verification — tests KERIA reger.saved isolation bug
    // Self-sufficient: auto-runs org-setup if needed
    {
      name: 'credential-chain',
      testMatch: /e2e-credential-chain\.spec\.ts/,
      use: browserConfig,
    },
    // Member removal — approve then remove a member
    // Requires test-accounts.json from registration tests
    {
      name: 'member-removal',
      testMatch: /e2e-member-removal\.spec\.ts/,
      use: browserConfig,
    },
    // Proposals — proposal lifecycle (API + UI)
    // Requires test-accounts.json from org-setup
    {
      name: 'proposals',
      testMatch: /e2e-proposals\.spec\.ts/,
      use: browserConfig,
    },
    // Projects & Contributions — full lifecycle (API + UI)
    // Requires test-accounts.json from org-setup
    {
      name: 'projects-contributions',
      testMatch: /e2e-projects-contributions\.spec\.ts/,
      use: browserConfig,
    },
    // Proposal link cards in chat — rich preview cards + detail modal
    // Requires test-accounts.json from org-setup
    {
      name: 'proposal-link-cards',
      testMatch: /e2e-proposal-link-cards\.spec\.ts/,
      use: browserConfig,
    },
    // Roles & Permissions — admin-managed RBAC (role policy matrix, custom
    // roles, Change Role integration, member denial). Bootstraps its own org
    // via org-setup; uses a registered member from test-accounts.json when
    // present, else seeds one via the admin init-member API.
    {
      name: 'roles-permissions',
      testMatch: /e2e-roles-permissions\.spec\.ts/,
      use: browserConfig,
      dependencies: ['org-setup'],
    },
    // Feature specs authored by swarm agents (one per issue). Bootstrap via
    // the self-sufficient org-setup + registration projects, which create the
    // org and a member and persist tests/e2e/test-accounts.json.
    {
      name: 'features',
      testMatch: /features\/issue-\d+\.spec\.ts/,
      use: browserConfig,
      dependencies: ['org-setup', 'registration-member'],
    },
    // Default project for running individual test files
    // Excludes tests that have dedicated projects above
    {
      name: 'chromium',
      use: browserConfig,
      testIgnore: [
        /e2e-org-setup\.spec\.ts/,
        /e2e-registration\.spec\.ts/,
        /e2e-invitation\.spec\.ts/,
        /e2e-multi-backend\.spec\.ts/,
        /e2e-wallet\.spec\.ts/,
        /e2e-activity\.spec\.ts/,
        /e2e-account-recovery\.spec\.ts/,
        /e2e-recovery-errors\.spec\.ts/,
        /e2e-keria-stress\.spec\.ts/,
        /e2e-chat\.spec\.ts/,
        /e2e-credential-chain\.spec\.ts/,
        /e2e-member-removal\.spec\.ts/,
        /e2e-proposals\.spec\.ts/,
        /e2e-projects-contributions\.spec\.ts/,
        /e2e-proposal-link-cards\.spec\.ts/,
        /e2e-roles-permissions\.spec\.ts/,
        /features\/issue-\d+\.spec\.ts/,
      ],
    },
  ],

  outputDir: './tests/e2e/results',

  // Auto-start a test dev server on port 9003 with KERI test network env vars.
  // Runs alongside the regular dev server (port 9002) without interference.
  webServer: {
    command: `npm run test:serve`,
    url: `http://localhost:${TEST_SERVER_PORT}`,
    reuseExistingServer: true,
    timeout: 120000,
  },
});
