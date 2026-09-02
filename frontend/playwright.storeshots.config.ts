import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * Play Store / App Store screenshot harness.
 *
 * Renders the app at a 1080x2400 phone raster (360x800 CSS px at DPR 3 — the
 * standard Android width) so `page.screenshot()` output drops straight into
 * `docs/mobile/store-listing/scripts/frame-screenshot.py`. The store framing
 * crops all native chrome, so a browser capture is indistinguishable from a
 * device one.
 *
 *   npx playwright test -c playwright.storeshots.config.ts --project=storeshots-bootstrap
 *   node ../docs/mobile/store-listing/scripts/seed-store-data.mjs
 *   npx playwright test -c playwright.storeshots.config.ts --project=storeshots-capture
 */
const phone = {
  ...devices['Desktop Chrome'],
  headless: !process.env.HEADED,
  viewport: { width: 360, height: 800 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
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
  ...base,
  // Bootstrap runs org setup + a full member registration + approval, which
  // includes multi-minute KERI credential waits.
  timeout: 900_000,
  reporter: [['list']],
  projects: [
    {
      name: 'storeshots-bootstrap',
      testMatch: /storeshots-bootstrap\.spec\.ts/,
      use: phone,
    },
    {
      name: 'storeshots-capture',
      testMatch: /storeshots-capture\.spec\.ts/,
      use: phone,
    },
  ],
});
