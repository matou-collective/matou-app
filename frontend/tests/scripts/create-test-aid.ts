/**
 * Test: Create a KERIA AID and verify account creation.
 *
 * Uses signify-ts directly (no browser) to:
 * 1. Boot a new KERIA agent with a random passcode
 * 2. Create an AID (without witnesses for speed)
 * 3. Verify the AID exists in KERIA
 *
 * Uses the same KERIA endpoints as the frontend (localhost:4901/4903).
 *
 * Prerequisites:
 *   - KERI test infrastructure running: cd infrastructure/keri && make up-test
 *   - Frontend deps installed: cd frontend && npm install
 *
 * Run from frontend/:
 *   npm run test:script
 */

import { describe, test, expect } from 'vitest';
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

async function createClient(label: string): Promise<{ client: SignifyClient; bran: string }> {
  const bran = randomPasscode();
  const client = new SignifyClient(KERIA_URL, bran, Tier.low, KERIA_BOOT_URL);

  try {
    await client.connect();
    console.log(`[${label}] Connected to existing agent`);
  } catch {
    await client.boot();
    await client.connect();
    console.log(`[${label}] Booted and connected new agent`);
  }

  return { client, bran };
}

describe('Create Test AID', () => {
  test('KERIA is reachable', async () => {
    const resp = await fetch(`${KERIA_URL}/`);
    // KERIA returns 401 when operational (auth required)
    expect([200, 401]).toContain(resp.status);
  });

  test('boot agent and create AID without witnesses', async () => {
    await ready();
    const name = `test-aid-${Date.now()}`;
    console.log(`Creating AID "${name}" (no witnesses)...`);

    const { client, bran } = await createClient(name);
    expect(bran).toBeTruthy();

    const result = await client.identifiers().create(name, {});
    const op = await result.op();
    await waitOperation(client, op, 60000);

    const aid = await client.identifiers().get(name);
    console.log(`AID created: ${aid.prefix}`);

    expect(aid.prefix).toBeTruthy();
    expect(aid.prefix).toMatch(/^E/);
    expect(aid.name).toBe(name);

    // Add end role for agent
    const agentId = client.agent?.pre || '';
    if (agentId) {
      const endRoleResult = await client.identifiers().addEndRole(name, 'agent', agentId);
      await waitOperation(client, await endRoleResult.op(), 30000);
      console.log('Agent end role added');
    }
  });

  test('boot agent and create AID with witness', async () => {
    await ready();
    const name = `test-witnessed-${Date.now()}`;
    console.log(`Creating AID "${name}" (with witness)...`);

    const { client } = await createClient(name);

    const wits = await fetchWitnessAIDs();
    const result = await client.identifiers().create(name, {
      wits: [wits[0]],
      toad: 1,
    });
    const op = await result.op();
    await waitOperation(client, op, 180000);

    const aid = await client.identifiers().get(name);
    console.log(`Witnessed AID created: ${aid.prefix}`);

    expect(aid.prefix).toBeTruthy();
    expect(aid.prefix).toMatch(/^E/);
    expect(aid.name).toBe(name);
  });
});
