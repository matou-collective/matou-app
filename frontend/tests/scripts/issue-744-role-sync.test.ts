// @vitest-environment happy-dom
/**
 * Issue #744 — a member who holds an Operations Steward credential is still
 * told "insufficient permissions".
 *
 * Root cause: the backend resolves RBAC roles from its local credential cache
 * (CredentialRoleLookup, #739), but that cache is only filled from credentials
 * the frontend syncs or from the community credential tree — which a member
 * cannot read while their any-sync ACL lacks the read key. A received steward
 * credential that shows in the wallet (read straight from KERIA) never reached
 * the cache, so role resolution stayed on [member].
 *
 * Fix: the wallet pushes the member's own role credentials to the backend
 * sync endpoint every time it loads credentials, so a received Operations
 * Steward credential upgrades the effective role even when the trees won't
 * sync.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
  roleCredentialsForBackendSync,
  type WalletCredential,
} from 'src/lib/walletCredential';

const { MY_AID, ORG_AID } = vi.hoisted(() => ({
  MY_AID: 'EMEmemberAID0000000000000000000000000000000',
  ORG_AID: 'EORGissuerAID000000000000000000000000000000',
}));

// Mutable, hoisted so the vi.mock factories can close over them.
const state = vi.hoisted(() => ({
  rawCredentials: [] as unknown[],
  currentAID: { prefix: 'EMEmemberAID0000000000000000000000000000000' } as { prefix: string } | null,
  syncCredentials: vi.fn(async () => ({ success: true, synced: 1, failed: 0 })),
}));

vi.mock('src/lib/keri/client', () => ({
  useKERIClient: () => ({
    getSignifyClient: () => ({
      credentials: () => ({ list: async () => state.rawCredentials }),
      schemas: () => ({ get: async () => ({ title: 'Membership', description: '' }) }),
    }),
  }),
}));
vi.mock('stores/identity', () => ({
  useIdentityStore: () => ({ currentAID: state.currentAID }),
}));
// The live-standing pass is exercised elsewhere (#687); here it is a passthrough.
vi.mock('src/lib/keri/communityStanding', () => ({
  withLiveStanding: async (creds: unknown[]) => creds,
}));
vi.mock('src/lib/api/client', () => ({
  syncCredentials: state.syncCredentials,
}));

import { useWalletStore } from 'stores/wallet';

/** A raw signify credential record the agent's `credentials().list()` returns. */
function rawCred(opts: {
  said: string;
  issuer?: string;
  recipient?: string;
  role?: string;
  status?: string;
}): Record<string, unknown> {
  return {
    sad: {
      d: opts.said,
      i: opts.issuer ?? ORG_AID,
      s: 'ESchemaSAID000000000000000000000000000000000',
      a: {
        i: opts.recipient ?? MY_AID,
        communityName: 'Test Community',
        role: opts.role ?? '',
        joinedAt: '2026-01-01T00:00:00Z',
      },
    },
    status: { s: opts.status ?? '0' },
  };
}

describe('#744 roleCredentialsForBackendSync — the pure filter', () => {
  const steward: WalletCredential = {
    said: 'ESTEWARD',
    schemaSaid: 'ESchema',
    schemaTitle: '',
    schemaDescription: '',
    issuerAid: ORG_AID,
    issueeAid: MY_AID,
    communityName: 'Test Community',
    role: 'Operations Steward',
    permissions: [],
    joinedAt: '2026-01-01T00:00:00Z',
    issuedAt: '',
    status: '0',
    claim: '',
    endorsementType: '',
    eventName: '',
    eventType: '',
    committee: '',
  };

  it('keeps a self-held role credential and shapes it for the backend', () => {
    const out = roleCredentialsForBackendSync([steward], MY_AID);
    expect(out).toEqual([
      {
        said: 'ESTEWARD',
        issuer: ORG_AID,
        recipient: MY_AID,
        schema: 'ESchema',
        data: { communityName: 'Test Community', role: 'Operations Steward', joinedAt: '2026-01-01T00:00:00Z' },
      },
    ]);
  });

  it('drops a non-role credential (e.g. an endorsement)', () => {
    const endorsement = { ...steward, said: 'EENDORSE', role: '' };
    expect(roleCredentialsForBackendSync([endorsement], MY_AID)).toEqual([]);
  });

  it('drops a credential issued to someone else', () => {
    const other = { ...steward, issueeAid: 'ESOMEONEELSE' };
    expect(roleCredentialsForBackendSync([other], MY_AID)).toEqual([]);
  });

  it('drops a revoked credential so it cannot re-grant a role', () => {
    const revoked = { ...steward, status: '1' };
    expect(roleCredentialsForBackendSync([revoked], MY_AID)).toEqual([]);
  });

  it('returns nothing when the member has no AID', () => {
    expect(roleCredentialsForBackendSync([steward], '')).toEqual([]);
  });
});

describe('#744 wallet.loadCredentials syncs role credentials to the backend', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    state.currentAID = { prefix: MY_AID };
    state.syncCredentials.mockClear();
  });

  it('pushes a received Operations Steward credential to the backend cache', async () => {
    state.rawCredentials = [
      rawCred({ said: 'EMEMBER', role: 'Member' }),
      rawCred({ said: 'ESTEWARD', role: 'Operations Steward' }),
    ];

    const store = useWalletStore();
    await store.loadCredentials();

    expect(state.syncCredentials).toHaveBeenCalledTimes(1);
    const arg = state.syncCredentials.mock.calls[0]![0] as {
      userAid: string;
      credentials: Array<{ said: string; data: { role: string } }>;
    };
    expect(arg.userAid).toBe(MY_AID);
    const synced = arg.credentials.map((c) => c.data.role).sort();
    expect(synced).toEqual(['Member', 'Operations Steward']);
    const steward = arg.credentials.find((c) => c.said === 'ESTEWARD');
    expect(steward?.data.role).toBe('Operations Steward');
  });

  it('does not call the backend when there are no role credentials to sync', async () => {
    state.rawCredentials = [rawCred({ said: 'EENDORSE', role: '' })];

    const store = useWalletStore();
    await store.loadCredentials();

    expect(state.syncCredentials).not.toHaveBeenCalled();
  });

  it('a failed backend sync does not break the wallet view', async () => {
    state.rawCredentials = [rawCred({ said: 'ESTEWARD', role: 'Operations Steward' })];
    state.syncCredentials.mockRejectedValueOnce(new Error('backend down'));

    const store = useWalletStore();
    await store.loadCredentials();

    expect(store.credentials.length).toBe(1);
    expect(store.credentialsError).toBeNull();
  });
});
