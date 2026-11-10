/**
 * IDSS membership issuance uses the ONE community registry (issue #612).
 *
 * ADR 0235 decision 4: on an IDSS backend every membership credential is
 * issued from `community.registry` (named in the community backend descriptor),
 * and per-steward registry creation is OFF. `resolveIssuingRegistry` is the
 * single seam the approve / re-issue paths call to pick the registry, so this
 * proves:
 *
 *  - idss → returns the descriptor's `community.registry` and NEVER lists or
 *    creates a registry on KERIA (no per-steward registry);
 *  - idss with no `community.registry` → hard error, never a silent fallback
 *    that would mint a per-steward registry the gateway never anchored;
 *  - legacy (non-idss) → the ONE org registry named by the org config's
 *    `registry.id` (steward peer registry: per-steward registries are gone).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const COMMUNITY_REGISTRY = 'ERegistrySAID0000000000000000000000000000000';

// A KERIA client whose registry surface records every call, so the test can
// assert nothing is listed/created on the idss path.
const registriesList = vi.fn(async () => [] as { name: string; regk: string }[]);
const createRegistry = vi.fn(async () => 'ELOCAL_STEWARD_REGISTRY');
const signifyClient = { registries: () => ({ list: registriesList }) };
const keriClientMock = {
  getSignifyClient: () => signifyClient,
  createRegistry,
};
vi.mock('src/lib/keri/client', () => ({ useKERIClient: () => keriClientMock }));
vi.mock('stores/identity', () => ({
  useIdentityStore: () => ({ currentAID: { prefix: 'DSTEWARDPREFIX000' } }),
}));

// The descriptor the loader returns is driven per-test.
let descriptor: unknown;
vi.mock('src/lib/clientConfig', () => ({
  getCommunityDescriptor: vi.fn(async () => {
    if (descriptor instanceof Error) throw descriptor;
    return descriptor;
  }),
}));

// The org config the legacy path reads, driven per-test.
let orgConfigResult: unknown;
vi.mock('src/api/config', () => ({
  fetchOrgConfig: vi.fn(async () => orgConfigResult),
}));

import { resolveIssuingRegistry } from 'src/lib/keri/registry';

beforeEach(() => {
  registriesList.mockClear();
  createRegistry.mockClear();
  descriptor = undefined;
  orgConfigResult = { status: 'configured', config: { registry: { id: 'EORG_REGISTRY' } } };
});

describe('resolveIssuingRegistry (#612, ADR 0235 d.4)', () => {
  it('idss: returns the descriptor community.registry and creates no registry', async () => {
    descriptor = {
      backend_kind: 'idss',
      community: { registry: COMMUNITY_REGISTRY },
    };

    const regk = await resolveIssuingRegistry('org-aid-name');

    expect(regk).toBe(COMMUNITY_REGISTRY);
    // Per-steward creation is OFF on idss: nothing touches KERIA's registries.
    expect(createRegistry).not.toHaveBeenCalled();
    expect(registriesList).not.toHaveBeenCalled();
  });

  it('idss without community.registry: hard error, never a per-steward fallback', async () => {
    descriptor = { backend_kind: 'idss', community: { registry: '' } };

    await expect(resolveIssuingRegistry('org-aid-name')).rejects.toThrow(
      /community\.registry/,
    );
    expect(createRegistry).not.toHaveBeenCalled();
  });

  it('legacy backend: the ONE org registry from org config, never a per-steward one', async () => {
    descriptor = { backend_kind: '', community: undefined };

    const regk = await resolveIssuingRegistry('org-aid-name');

    expect(regk).toBe('EORG_REGISTRY');
    expect(registriesList).not.toHaveBeenCalled();
    expect(createRegistry).not.toHaveBeenCalled();
  });

  it('legacy backend, config server unreachable: uses the cached org config registry', async () => {
    descriptor = { backend_kind: '' };
    orgConfigResult = { status: 'server_unreachable', cached: { registry: { id: 'ECACHED_REGISTRY' } } };

    await expect(resolveIssuingRegistry('org-aid-name')).resolves.toBe('ECACHED_REGISTRY');
  });

  it('legacy backend with no org registry: hard error, never creates one', async () => {
    descriptor = { backend_kind: '' };
    orgConfigResult = { status: 'configured', config: {} };

    await expect(resolveIssuingRegistry('org-aid-name')).rejects.toThrow(/names no registry/);
    expect(createRegistry).not.toHaveBeenCalled();
  });

  it('descriptor unavailable: falls back to the org config registry, not an idss error', async () => {
    descriptor = new Error('config server unreachable');

    await expect(resolveIssuingRegistry('org-aid-name')).resolves.toBe('EORG_REGISTRY');
  });
});
