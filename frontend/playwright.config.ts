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
  timeout: 120000, // 2 minutes for KERIA operations
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
    // Recovery & error handling - independent
    {
      name: 'recovery-errors',
      testMatch: /e2e-recovery-errors\.spec\.ts/,
      use: browserConfig,
    },
    // Default project for running individual test files
    {
      name: 'chromium',
      use: browserConfig,
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
