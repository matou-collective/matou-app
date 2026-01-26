import { defineConfig, devices } from '@playwright/test';

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
    baseURL: 'http://localhost:9002',
    trace: 'on-first-retry',
    screenshot: 'on',
    video: 'on-first-retry',
  },

  projects: [
    // Org setup must run first - creates the organization
    {
      name: 'org-setup',
      testMatch: /org-setup\.spec\.ts/,
      use: browserConfig,
    },
    // Registration tests depend on org existing
    {
      name: 'registration',
      testMatch: /registration\.spec\.ts/,
      dependencies: ['org-setup'],
      use: browserConfig,
    },
    // Default project for running individual test files
    {
      name: 'chromium',
      use: browserConfig,
    },
  ],

  outputDir: './tests/e2e/results',

  // Don't start dev server - assume it's already running
  // webServer: {
  //   command: 'npm run dev',
  //   url: 'http://localhost:9002',
  //   reuseExistingServer: true,
  // },
});
