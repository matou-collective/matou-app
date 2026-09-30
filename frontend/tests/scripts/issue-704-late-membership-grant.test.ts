/**
 * Regression for issue #704 — "a membership grant that arrives after the
 * credential landed is ignored".
 *
 * A member approved from the IDSS control panel got their Membership credential
 * but never the any-sync space invite, so their app waited on "Receiving space
 * invite" for good. Re-approving them re-sends the Membership grant WITH the
 * invite embedded — but `pollForGrants` only handled a Membership grant while
 * no credential had landed yet (`else if (!credentialReceived.value)`). Once the
 * credential was in the wallet, every later Membership grant fell through that
 * branch: its `space_invite` was never read, and it was never admitted or
 * marked read, so it sat unread for good.
 *
 * The fix handles a Membership grant whether or not the credential has already
 * landed: it always reads any embedded `space_invite`, and admits the grant
 * (idempotent on the credential per #470) so the notification is marked read.
 *
 * These tests drive `startPolling` — which runs `pollForGrants` once — with a
 * credential already in the wallet and an unread Membership grant, and assert
 * the invite is taken and the notification cleared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEMBERSHIP_SCHEMA = 'ESCHEMA';
const CRED_SAID = 'ECredSaid';
const ORG_AID = 'EOrg';
const MEMBER_AID = 'EMember';
const GRANT_NOTE_ID = 'note-grant-1';

const membershipCred = {
  sad: { d: CRED_SAID, s: MEMBERSHIP_SCHEMA, i: ORG_AID, a: { i: MEMBER_AID } },
};

const h = vi.hoisted(() => {
  const markMock = vi.fn(async () => {});
  const state = {
    notes: [] as Array<{ i: string; r: boolean; a: { r: string; d: string } }>,
    creds: [] as unknown[],
    walletHasCredential: false,
    grantExn: null as unknown,
  };
  const client = {
    agent: { pre: 'EAgentSelf' },
    exchanges: () => ({ get: async () => state.grantExn }),
    credentials: () => ({
      list: async () => (state.walletHasCredential ? [{ sad: { d: CRED_SAID } }] : []),
    }),
    notifications: () => ({
      mark: markMock,
      list: async () => ({ notes: state.notes }),
    }),
    identifiers: () => ({ get: async () => ({ prefix: MEMBER_AID }) }),
    keyStates: () => ({ get: async () => [{ s: '1' }] }),
    ipex: () => ({ submitAdmit: async () => ({}) }),
  };
  return { markMock, state, client };
});

vi.mock('src/lib/keri/client', () => ({
  useKERIClient: () => ({
    getSignifyClient: () => h.client,
    getCesrUrl: () => 'http://localhost:3903',
    resolveOOBI: async () => {},
    resolveOOBIWithReason: async () => ({ ok: true }),
    resolveViaWitnesses: async () => {},
    queryKeyStateToSn: async () => {},
    refreshKeyState: async () => {},
  }),
}));

vi.mock('stores/identity', () => ({
  useIdentityStore: () => ({ currentAID: { prefix: MEMBER_AID } }),
}));

vi.mock('src/api/config', () => ({
  getOrFetchOrgConfig: async () => ({ organization: { aid: ORG_AID }, admins: [] }),
}));

vi.mock('src/lib/clientConfig', () => ({
  getMembershipSchemaSaid: async () => MEMBERSHIP_SCHEMA,
  getMembershipSchemaOobi: async () => undefined,
}));

vi.mock('src/composables/useKERINotificationService', () => ({
  useKERINotificationService: () => ({
    notifications: { value: h.state.notes },
    credentials: { value: h.state.creds },
    lastFetchTime: { value: 0 },
    triggerNow: async () => {},
  }),
}));

vi.mock('src/lib/api/client', () => ({ BACKEND_URL: 'http://localhost:9080' }));

vi.mock('src/lib/secureStorage', () => ({
  secureStorage: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

vi.mock('src/lib/selfAgentOobi', () => ({ isSelfAgentOobi: () => false }));

import { useCredentialPolling } from 'src/composables/useCredentialPolling';

/** Let the fire-and-forget pollForGrants chain settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function grantNote() {
  return { i: GRANT_NOTE_ID, r: false, a: { r: '/exn/ipex/grant', d: 'Egrantexn' } };
}

function grantExnWithMessage(m: string) {
  return {
    exn: {
      i: ORG_AID,
      a: { m },
      e: { acdc: { d: CRED_SAID, s: MEMBERSHIP_SCHEMA } },
    },
  };
}

describe('useCredentialPolling — late membership grant (issue #704)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Credential already in the wallet (both the notification-service view and
    // the client-side idempotency lookup).
    h.state.creds = [membershipCred];
    h.state.walletHasCredential = true;
    h.state.notes = [grantNote()];
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ synced: 1, spaces: [] }),
      text: async () => '',
    })) as unknown as typeof fetch;
  });

  it('takes the embedded space invite and marks the grant read', async () => {
    h.state.grantExn = grantExnWithMessage(
      JSON.stringify({
        type: 'space_invite',
        inviteKey: 'AInviteKey',
        spaceId: 'ESpace',
        readOnlyInviteKey: 'AReadOnlyKey',
        readOnlySpaceId: 'EReadOnlySpace',
      }),
    );

    const polling = useCredentialPolling();
    await polling.startPolling();
    await flush();

    // Credential was already in the wallet…
    expect(polling.credentialReceived.value).toBe(true);
    // …yet the invite embedded in the late grant is now taken.
    expect(polling.spaceInviteReceived.value).toBe(true);
    expect(polling.spaceInviteKey.value).toBe('AInviteKey');
    expect(polling.spaceId.value).toBe('ESpace');
    expect(polling.readOnlyInviteKey.value).toBe('AReadOnlyKey');
    expect(polling.readOnlySpaceId.value).toBe('EReadOnlySpace');
    // And the grant notification was cleared (idempotent admit, #470).
    expect(h.markMock).toHaveBeenCalledWith(GRANT_NOTE_ID);
  });

  it('marks the grant read and changes nothing else when the message is empty', async () => {
    h.state.grantExn = grantExnWithMessage('');

    const polling = useCredentialPolling();
    await polling.startPolling();
    await flush();

    expect(polling.credentialReceived.value).toBe(true);
    // No invite in the message — nothing taken…
    expect(polling.spaceInviteReceived.value).toBe(false);
    expect(polling.spaceInviteKey.value).toBe(null);
    // …but the grant is still cleared so it does not sit unread for good.
    expect(h.markMock).toHaveBeenCalledWith(GRANT_NOTE_ID);
  });
});
