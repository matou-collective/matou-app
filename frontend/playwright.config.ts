import { defineConfig, devices } from '@playwright/test';

// Test dev server port (separate from dev server on 9002)
const TEST_SERVER_PORT = 9003;

// Shared browser config
const browserConfig = {
  ...devices['Desktop Chrome'],
  headless: false, // Show browser for debugging
  launchOptions: {
    slowMo: 100, // Slow down for visibility
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
  timeout: 240000, // 4 minutes: registration (~90s) + approval (~30s) + sync (~60s)
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: `http://localhost:${TEST_SERVER_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'on',
    video: 'on-first-retry',
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
    // Registration stress test - concurrent registrations with admin processing
    {
      name: 'stress',
      testMatch: /e2e-registration-stress\.spec\.ts/,
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
        /e2e-account-recovery\.spec\.ts/,
        /e2e-recovery-errors\.spec\.ts/,
        /e2e-registration-stress\.spec\.ts/,
        /e2e-chat\.spec\.ts/,
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
