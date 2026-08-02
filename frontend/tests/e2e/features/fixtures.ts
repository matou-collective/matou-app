import { test as base, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { setupTestConfig } from '../utils/mock-config';
import { BackendManager, BackendInstance } from '../utils/backend-manager';
import { loginWithMnemonic, setupBackendRouting } from '../utils/test-helpers';

// Accounts persisted by the org-setup / registration projects (declared as
// project dependencies of `features`). Feature specs never register/login
// manually — they consume these fixtures only.
interface TestAccounts {
  admin?: { mnemonic: string[]; aid: string; name: string };
  member?: { mnemonic: string[]; aid?: string; name?: string };
}

function loadAccounts(): TestAccounts {
  const p = path.join(__dirname, '..', 'test-accounts.json');
  if (!fs.existsSync(p)) {
    throw new Error(
      'test-accounts.json missing — run via `--project=features` so the ' +
        'org-setup/registration dependencies bootstrap the test env first.'
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as TestAccounts;
}

type Fixtures = {
  adminPage: Page;
  memberPage: Page;
  snap: (page: Page, label: string) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  adminPage: async ({ browser }, use) => {
    const accounts = loadAccounts();
    if (!accounts.admin?.mnemonic) throw new Error('no admin in test-accounts.json');
    const ctx = await browser.newContext();
    await setupTestConfig(ctx);
    const page = await ctx.newPage();
    await loginWithMnemonic(page, accounts.admin.mnemonic);
    await use(page);
    await ctx.close();
  },
  memberPage: async ({ browser }, use) => {
    const accounts = loadAccounts();
    if (!accounts.member?.mnemonic) throw new Error('no member in test-accounts.json');

    // Member gets its own backend + data dir, mirroring
    // e2e-projects-contributions.spec.ts (~lines 356-361), so member writes
    // never land in the admin backend's data.
    const backends = new BackendManager();
    let memberBackend: BackendInstance;
    try {
      memberBackend = await backends.start('features-member');
    } catch (e) {
      throw new Error(`fixtures: failed to start member backend: ${e}`);
    }

    const ctx = await browser.newContext();
    await setupTestConfig(ctx);
    await setupBackendRouting(ctx, memberBackend.port);
    const page = await ctx.newPage();
    await loginWithMnemonic(page, accounts.member.mnemonic);
    await use(page);
    await ctx.close();
    await backends.stopAll();
  },
  snap: async ({}, use, testInfo) => {
    const m = path.basename(testInfo.file).match(/issue-(\d+)/);
    const dir = path.join(__dirname, '..', 'results', 'snaps', `issue-${m ? m[1] : 'unknown'}`);
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    await use(async (page: Page, label: string) => {
      n++;
      const name = `${String(n).padStart(2, '0')}-${label.replace(/[^a-z0-9-]/gi, '_')}.png`;
      await page.screenshot({ path: path.join(dir, name), fullPage: true });
    });
  },
});

export { expect };
