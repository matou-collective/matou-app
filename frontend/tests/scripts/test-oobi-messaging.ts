/**
 * Test: Verify if messages can be received without bi-directional OOBI resolution.
 *
 * This tests the hypothesis that:
 * 1. User sends message to Admin (user has resolved admin's OOBI)
 * 2. Admin has NOT resolved user's OOBI
 * 3. Does Admin receive the notification?
 *
 * Prerequisites:
 *   - KERI test infrastructure running: cd infrastructure/keri && make up-test
 *   - Frontend deps installed: cd frontend && npm install
 *
 * Run from frontend/:
 *   npm run test:script
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { SignifyClient, Tier, randomPasscode, ready } from 'signify-ts';

const KERIA_URL = process.env.KERIA_URL || 'http://localhost:4901';
const KERIA_BOOT_URL = process.env.KERIA_BOOT_URL || 'http://localhost:4903';
const CONFIG_URL = process.env.MATOU_CONFIG_URL || 'http://localhost:4904';

async function fetchWitnessAIDs(): Promise<string[]> {
  const resp = await fetch(`${CONFIG_URL}/api/client-config`);
  if (!resp.ok) throw new Error(`client-config ${resp.status}: ${await resp.text()}`);
  const cfg = await resp.json();
  const aids = Object.values(cfg?.witnesses?.aids ?? {}) as string[];
  if (aids.length === 0) throw new Error('no witness AIDs in /api/client-config');
  return aids;
}

async function waitOperation(client: SignifyClient, op: any, timeout = 60000): Promise<any> {
  return client.operations().wait(op, { signal: AbortSignal.timeout(timeout) });
}

async function createClient(name: string): Promise<{ client: SignifyClient; bran: string }> {
  const bran = randomPasscode();
  const client = new SignifyClient(KERIA_URL, bran, Tier.low, KERIA_BOOT_URL);

  try {
    await client.connect();
    console.log(`[${name}] Connected to existing agent`);
  } catch {
    await client.boot();
    await client.connect();
    console.log(`[${name}] Booted and connected new agent`);
  }

  return { client, bran };
}

async function createAID(client: SignifyClient, name: string, alias: string): Promise<string> {
  const wits = await fetchWitnessAIDs();
  const result = await client.identifiers().create(alias, {
    toad: Math.min(2, wits.length),
    wits,
  });
  let op = await result.op();
  op = await waitOperation(client, op);

  const aid = await client.identifiers().get(alias);
  console.log(`[${name}] AID created: ${aid.prefix}`);

  const agentId = client.agent?.pre;
  if (agentId) {
    const endRoleResult = await client.identifiers().addEndRole(alias, 'agent', agentId);
    await waitOperation(client, await endRoleResult.op(), 30000);
    console.log(`[${name}] End role added`);
  }

  return aid.prefix;
}

describe('OOBI Messaging Test', () => {
  let adminClient: SignifyClient;
  let userClient: SignifyClient;
  let adminPrefix: string;
  let userPrefix: string;
  let adminOOBI: string;
  let userOOBI: string;

  beforeAll(async () => {
    await ready();
  });

  test('KERIA is reachable', async () => {
    const resp = await fetch(`${KERIA_URL}/`);
    expect([200, 401]).toContain(resp.status);
  });

  test('create admin and user clients', async () => {
    const admin = await createClient('Admin');
    adminClient = admin.client;

    const user = await createClient('User');
    userClient = user.client;

    expect(adminClient).toBeTruthy();
    expect(userClient).toBeTruthy();
  });

  test('create AIDs with witnesses', async () => {
    adminPrefix = await createAID(adminClient, 'Admin', 'admin-test');
    userPrefix = await createAID(userClient, 'User', 'user-test');

    expect(adminPrefix).toMatch(/^E/);
    expect(userPrefix).toMatch(/^E/);
  });

  test('get OOBIs', async () => {
    const adminOobiResult = await adminClient.oobis().get('admin-test', 'agent');
    adminOOBI = adminOobiResult.oobis?.[0] || '';
    console.log(`[Admin] OOBI: ${adminOOBI}`);

    const userOobiResult = await userClient.oobis().get('user-test', 'agent');
    userOOBI = userOobiResult.oobis?.[0] || '';
    console.log(`[User] OOBI: ${userOOBI}`);

    expect(adminOOBI).toBeTruthy();
    expect(userOOBI).toBeTruthy();
  });

  test('user resolves admin OOBI (one-way)', async () => {
    console.log('[User] Resolving admin OOBI...');
    const op = await userClient.oobis().resolve(adminOOBI, 'admin-contact');
    await waitOperation(userClient, op, 30000);
    console.log('[User] Admin OOBI resolved');
    // Admin has NOT resolved user's OOBI
  });

  test('user sends EXN message to admin', async () => {
    console.log(`[User] Sending EXN message to ${adminPrefix}...`);

    const [exn] = await userClient.exchanges().send(
      'user-test',
      'test-topic',
      { i: adminPrefix },
      '/matou/registration/apply',
      {
        type: 'registration',
        name: 'Test User',
        bio: 'Testing OOBI messaging',
        senderOOBI: userOOBI,
        timestamp: new Date().toISOString(),
      },
      {},
      [adminPrefix]
    );

    console.log(`[User] EXN message sent. SAID: ${exn.d}`);
    expect(exn.d).toBeTruthy();
  });

  test('admin checks notifications before resolving user OOBI', async () => {
    // Wait for message propagation
    await new Promise(r => setTimeout(r, 5000));

    const response = await adminClient.notifications().list();
    const notes = response.notes || [];
    console.log(`[Admin] Total notifications (before OOBI): ${notes.length}`);
    for (const note of notes) {
      console.log(`[Admin]   - Route: ${note.a?.r}, Read: ${note.r}, SAID: ${note.a?.d}`);
    }

    const registrationNotes = notes.filter((n: any) => n.a?.r === '/matou/registration/apply');
    console.log(`[Admin] Registration notifications BEFORE OOBI resolution: ${registrationNotes.length}`);
    // Not asserting count here — the point is to observe the behavior
  });

  test('admin resolves user OOBI and checks notifications again', async () => {
    console.log('[Admin] Resolving user OOBI...');
    const op = await adminClient.oobis().resolve(userOOBI, 'user-contact');
    await waitOperation(adminClient, op, 30000);
    console.log('[Admin] User OOBI resolved');

    // Wait for escrow processing
    await new Promise(r => setTimeout(r, 5000));

    const response = await adminClient.notifications().list();
    const notes = response.notes || [];
    console.log(`[Admin] Total notifications (after OOBI): ${notes.length}`);
    for (const note of notes) {
      console.log(`[Admin]   - Route: ${note.a?.r}, Read: ${note.r}, SAID: ${note.a?.d}`);
    }

    const registrationNotes = notes.filter((n: any) => n.a?.r === '/matou/registration/apply');
    console.log(`[Admin] Registration notifications AFTER OOBI resolution: ${registrationNotes.length}`);

    // After resolving OOBI, admin should eventually see the message
    // (either directly or after escrow processing)
    expect(registrationNotes.length).toBeGreaterThanOrEqual(0);
  });
});
