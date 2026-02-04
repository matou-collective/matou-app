/**
 * KERI Test Network utilities for frontend E2E tests.
 *
 * Manages the KERI infrastructure lifecycle (KERIA, witnesses, schema server,
 * config server) via the infrastructure/keri/ Docker Compose setup (test targets).
 *
 * This is the TypeScript equivalent of the Go testnet packages:
 *   - backend/internal/keri/testnet/testnet.go
 *   - backend/internal/anysync/testnet/testnet.go
 *
 * Usage in Playwright globalSetup:
 *   import { setupKERINetwork, teardownKERINetwork } from './utils/keri-testnet';
 *
 * Usage in test files:
 *   import { keriEndpoints, isKERIHealthy } from './utils/keri-testnet';
 */

import { execSync, exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/** KERI infrastructure endpoint URLs (test network, +1000 port offset) */
export const keriEndpoints = {
  /** KERIA Admin API (requires auth) */
  adminURL: 'http://localhost:4901',
  /** KERIA CESR/OOBI API */
  cesrURL: 'http://localhost:4902',
  /** KERIA Boot API (agent creation) */
  bootURL: 'http://localhost:4903',
  /** Config server (org config management) */
  configURL: 'http://localhost:4904',
  /** Schema server */
  schemaURL: 'http://localhost:8723',
  /** Witness endpoints */
  witnesses: [
    'http://localhost:6643',
    'http://localhost:6645',
    'http://localhost:6647',
  ],
} as const;

/** AnySync test network endpoint URLs */
export const anysyncEndpoints = {
  /** Coordinator metrics (Prometheus) - port 9104 maps to container's 8000 */
  coordinatorMetrics: 'http://127.0.0.1:9104',
  /** Sync node 1 API */
  node1API: 'http://127.0.0.1:9181',
} as const;

/** Backend test server */
export const backendEndpoint = 'http://localhost:9080' as const;

/** Witness AIDs from the witness-demo image */
export const witnessAIDs = {
  wan: 'BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha',
  wil: 'BLskRTInXnMxWaGqcpSyMgo0nYbalW99cGZESrz3zapM',
  wes: 'BIKKuvBwpmDVA4Ds-EpL5bt9OqPzWPja2LigFYZN2YfX',
} as const;

/**
 * Resolve the absolute path to the KERI infrastructure directory.
 * Uses MATOU_KERI_INFRA_DIR env var, falling back to sibling repo at ../matou-infrastructure/keri.
 */
function getInfraPath(): string {
  const envPath = process.env.MATOU_KERI_INFRA_DIR;
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(`KERI infrastructure not found at ${envPath} (from MATOU_KERI_INFRA_DIR)`);
    }
    return path.resolve(envPath);
  }

  // Default: assume matou-infrastructure is a sibling directory to matou-app
  const siblingPath = path.resolve(__dirname, '..', '..', '..', '..', '..', 'matou-infrastructure', 'keri');
  if (fs.existsSync(siblingPath)) {
    return siblingPath;
  }

  throw new Error(
    'KERI infrastructure not found. Set MATOU_KERI_INFRA_DIR env var ' +
      'or clone matou-infrastructure as a sibling directory.'
  );
}

/**
 * Run a make target in the infrastructure/keri/ directory.
 * Appends '-test' to the target name so it uses .env.test (test network ports).
 */
function runMake(target: string, options?: { silent?: boolean; timeout?: number }): string {
  const infraPath = getInfraPath();
  const silent = options?.silent ? '-s' : '';
  const timeout = options?.timeout ?? 120_000;
  const testTarget = `${target}-test`;

  try {
    const result = execSync(`make ${silent} ${testTarget}`.trim(), {
      cwd: infraPath,
      timeout,
      encoding: 'utf-8',
      stdio: options?.silent ? 'pipe' : 'inherit',
    });
    return typeof result === 'string' ? result.trim() : '';
  } catch (err) {
    if (options?.silent) {
      return '';
    }
    throw err;
  }
}

/**
 * Check if the KERI infrastructure is already running.
 */
export function isKERIRunning(): boolean {
  try {
    const output = runMake('is-running', { silent: true, timeout: 10_000 });
    return output === 'true';
  } catch {
    return false;
  }
}

/**
 * Check if the KERI infrastructure is healthy (all services ready).
 */
export function isKERIHealthy(): boolean {
  try {
    const output = runMake('ready', { silent: true, timeout: 15_000 });
    return output === 'ready';
  } catch {
    return false;
  }
}

/**
 * Check individual service health via HTTP.
 * Returns a map of service name to reachability status.
 */
export async function checkServiceHealth(): Promise<Record<string, boolean>> {
  const checks: Record<string, { url: string; expectStatus: number[] }> = {
    keria: { url: `${keriEndpoints.adminURL}/`, expectStatus: [401] },
    boot: { url: `${keriEndpoints.bootURL}/`, expectStatus: [200, 404, 405] },
    schema: { url: `${keriEndpoints.schemaURL}/`, expectStatus: [200] },
    config: { url: `${keriEndpoints.configURL}/api/health`, expectStatus: [200] },
    anysync: { url: `${anysyncEndpoints.coordinatorMetrics}/`, expectStatus: [200, 404] },
    backend: { url: `${backendEndpoint}/health`, expectStatus: [200] },
  };

  const results: Record<string, boolean> = {};

  for (const [name, check] of Object.entries(checks)) {
    try {
      const resp = await fetch(check.url, { signal: AbortSignal.timeout(5000) });
      results[name] = check.expectStatus.includes(resp.status);
    } catch {
      results[name] = false;
    }
  }

  return results;
}

/** Service group definitions for startup instructions */
const serviceGroups: Record<string, { services: string[]; label: string; startCmd: string }> = {
  keri: {
    services: ['keria', 'boot', 'schema', 'config'],
    label: 'KERI test network (KERIA, witnesses, schema, config)',
    startCmd: 'cd infrastructure/keri && make start-and-wait-test',
  },
  anysync: {
    services: ['anysync'],
    label: 'AnySync test network (coordinator, sync nodes, mongo, redis)',
    startCmd: 'cd infrastructure/any-sync && make start-and-wait-test',
  },
  backend: {
    services: ['backend'],
    label: 'Backend server in test mode (admin instance on port 9080)',
    startCmd: 'cd backend && MATOU_ENV=test go run ./cmd/server',
  },
};

/**
 * Check that all required test services are reachable.
 * Throws a descriptive error listing which services are down and how to start them.
 *
 * Call at the start of test.beforeAll() to fail fast with actionable instructions.
 */
export async function requireAllTestServices(): Promise<void> {
  const health = await checkServiceHealth();
  const downServices = Object.entries(health).filter(([, ok]) => !ok).map(([name]) => name);

  if (downServices.length === 0) return;

  // Build error message grouping services by their startup command
  const lines: string[] = [
    'Required test services are not reachable:',
    '',
  ];

  for (const [, group] of Object.entries(serviceGroups)) {
    const downInGroup = group.services.filter(s => downServices.includes(s));
    if (downInGroup.length > 0) {
      lines.push(`  [DOWN] ${group.label}`);
      lines.push(`         Start: ${group.startCmd}`);
      lines.push('');
    }
  }

  lines.push('Start all services before running E2E tests:');
  lines.push('  1. cd infrastructure/keri && make start-and-wait-test');
  lines.push('  2. cd infrastructure/any-sync && make start-and-wait-test');
  lines.push('  3. cd backend && MATOU_ENV=test go run ./cmd/server &');
  lines.push('  4. cd frontend && npm run test:serve');

  throw new Error(lines.join('\n'));
}

/** State tracking for setup/teardown */
let weStartedNetwork = false;

/**
 * Start the KERI test infrastructure.
 *
 * - If already running, does nothing (and teardown will not stop it).
 * - Respects KEEP_KERIA_NETWORK=1 to keep running after tests.
 *
 * Call from Playwright globalSetup or test.beforeAll.
 */
export function setupKERINetwork(options?: { verbose?: boolean }): void {
  const verbose = options?.verbose ?? process.env.TEST_VERBOSE === '1';

  if (isKERIRunning()) {
    if (verbose) {
      console.log('[keri-testnet] KERI infrastructure already running');
    }
    weStartedNetwork = false;
    return;
  }

  if (verbose) {
    console.log('[keri-testnet] Starting KERI infrastructure...');
  }

  runMake('start-and-wait', { timeout: 180_000 });
  weStartedNetwork = true;

  if (verbose) {
    console.log('[keri-testnet] KERI infrastructure ready');
  }
}

/**
 * Stop the KERI test infrastructure.
 *
 * Only stops if we started it AND KEEP_KERIA_NETWORK is not set.
 *
 * Call from Playwright globalTeardown or test.afterAll.
 */
export function teardownKERINetwork(options?: { verbose?: boolean }): void {
  const verbose = options?.verbose ?? process.env.TEST_VERBOSE === '1';

  if (!weStartedNetwork) {
    if (verbose) {
      console.log('[keri-testnet] We did not start the network, skipping teardown');
    }
    return;
  }

  if (process.env.KEEP_KERIA_NETWORK === '1') {
    if (verbose) {
      console.log('[keri-testnet] Keeping KERI infrastructure running (KEEP_KERIA_NETWORK=1)');
    }
    return;
  }

  if (verbose) {
    console.log('[keri-testnet] Stopping KERI infrastructure...');
  }

  try {
    runMake('down', { timeout: 60_000 });
  } catch (err) {
    console.warn('[keri-testnet] Warning: failed to stop KERI infrastructure:', err);
  }

  weStartedNetwork = false;
}

/**
 * Require the KERI network to be healthy. Throws if not.
 * Use at the start of test suites that need KERIA.
 */
export function requireKERINetwork(): void {
  if (!isKERIHealthy()) {
    throw new Error(
      'KERI test infrastructure is not running or not healthy.\n' +
      'This usually means the Docker containers are stopped.\n\n' +
      'Start the KERI test network:\n' +
      '  cd infrastructure/keri && make up-test\n\n' +
      'Then wait for services to be ready:\n' +
      '  make ready-test'
    );
  }
}
