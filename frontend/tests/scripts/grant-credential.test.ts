import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KERIClient } from 'src/lib/keri/client';

/**
 * Unit coverage for KERIClient.grantCredential — the #488 re-grant path used
 * by approveRegistration when the wallet already holds an ACTIVE membership
 * credential for the applicant (a prior run died between issue and grant).
 *
 * The idempotency test (admin-actions-idempotency.test.ts) mocks this method
 * away, so nothing else proves what it does against the signify client. What
 * must hold:
 *  - it sources ACDC / iss / anc from `credentials().get(said)` and never
 *    mints a new credential (`credentials().issue` untouched);
 *  - the issuer KEL is pushed to the recipient BEFORE the grant lands (the
 *    issue #51 lesson — grant first and KERIA escrows it forever);
 *  - the grant goes to the applicant, and submitGrant targets the applicant;
 *  - a GROUP issuer (org stewards) is gated on the anchoring ixn's
 *    `group.<said>` witness op and re-pushes the group KEL to the other
 *    signing members, exactly like issueCredential (issues #51 / #63);
 *  - a credential whose record cannot be reconstituted (missing anc, or a 404
 *    from KERIA) fails loudly without submitting anything.
 */

// pushGroupKelToOtherMembers reads the org admins from the config module.
vi.mock('src/api/config', () => ({
  fetchOrgConfig: vi.fn(async () => ({
    status: 'configured',
    config: { admins: [{ aid: 'DACTINGMEMBER' }, { aid: 'DOTHERMEMBER' }] },
  })),
}));

const ISSUER = 'EORGAID000000000000000000000000000000000000';
const GROUP = 'EGROUPAID0000000000000000000000000000000000';
const RECIPIENT = 'DAPPLICANT000000000000000000000000000000000';
const CRED_SAID = 'ECREDSAID00000000000000000000000000000000000';
const ANC_SAID = 'EANCSAID000000000000000000000000000000000000';

function credRecord(overrides: Record<string, unknown> = {}) {
  return {
    sad: {
      v: 'ACDC10JSON000000_',
      d: CRED_SAID,
      i: ISSUER,
      ri: 'EREGISTRY',
      s: 'ESCHEMA',
      a: { d: 'EATTRS', i: RECIPIENT, communityName: 'MATOU', role: 'Member' },
    },
    iss: { v: 'KERI10JSON000000_', t: 'iss', d: 'EISSSAID', i: CRED_SAID, s: '0', ri: 'EREGISTRY', dt: '2026-09-10T00:00:00.000000+00:00' },
    anc: { v: 'KERI10JSON000000_', t: 'ixn', d: ANC_SAID, i: ISSUER, s: '3', p: 'EPRIOR', a: [{ i: CRED_SAID, s: '0', d: 'EISSSAID' }] },
    status: { et: 'iss', s: '0' },
    ...overrides,
  };
}

type Calls = string[];

function makeClient(
  kc: KERIClient,
  opts: { issuer?: Record<string, unknown>; cred?: Record<string, unknown> | 'notfound'; calls: Calls },
) {
  const issuer = opts.issuer ?? { name: 'org', prefix: ISSUER };
  const grant = vi.fn(async (args: Record<string, unknown>) => {
    opts.calls.push('grant');
    return [{ ked: { d: 'EGRANTSAID' }, args }, ['sig'], '-end'];
  });
  const submitGrant = vi.fn(async () => {
    opts.calls.push('submitGrant');
  });
  const issue = vi.fn();
  const get = vi.fn(async (said: string) => {
    opts.calls.push(`credentials.get:${said}`);
    if (opts.cred === 'notfound') throw new Error('HTTP GET /credentials/x - 404 Not Found');
    return opts.cred ?? credRecord();
  });
  const opGet = vi.fn(async (name: string) => {
    opts.calls.push(`operations.get:${name}`);
    return { name, done: true, response: { t: 'ixn', s: '3' } };
  });
  const stub = {
    state: vi.fn().mockResolvedValue({}),
    identifiers: () => ({
      get: vi.fn(async () => issuer),
      list: vi.fn(async () => ({ aids: [issuer] })),
    }),
    credentials: () => ({ get, issue }),
    ipex: () => ({ grant, submitGrant }),
    operations: () => ({ get: opGet }),
  };
  (kc as unknown as { client: unknown }).client = stub;
  (kc as unknown as { connected: boolean }).connected = true;
  const pushKelToAgent = vi
    .spyOn(kc, 'pushKelToAgent')
    .mockImplementation(async (pre: string, dest: string) => {
      opts.calls.push(`push:${pre}->${dest}`);
      return { pushed: 1, failed: 0 };
    });
  return { grant, submitGrant, issue, get, opGet, pushKelToAgent };
}

describe('KERIClient.grantCredential (#488 re-grant of an existing SAID)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('re-grants the stored ACDC/iss/anc to the applicant, pushing the issuer KEL first, without issuing', async () => {
    const kc = new KERIClient();
    const calls: Calls = [];
    const m = makeClient(kc, { calls });

    const result = await kc.grantCredential('org', CRED_SAID, RECIPIENT, '{"invite":"x"}');

    expect(result).toEqual({ said: CRED_SAID });
    expect(m.issue).not.toHaveBeenCalled();
    expect(m.get).toHaveBeenCalledWith(CRED_SAID);

    // Recipient push strictly before the grant is built/submitted (#51).
    expect(calls).toEqual([
      `credentials.get:${CRED_SAID}`,
      `push:${ISSUER}->${RECIPIENT}`,
      'grant',
      'submitGrant',
    ]);

    // Grant carries the existing credential's own SAIDs, addressed to the applicant.
    const grantArgs = m.grant.mock.calls[0]![0] as {
      senderName: string; recipient: string; message: string;
      acdc: { said: string }; iss: { said: string }; anc: { said: string };
    };
    expect(grantArgs.senderName).toBe(ISSUER);
    expect(grantArgs.recipient).toBe(RECIPIENT);
    expect(grantArgs.message).toBe('{"invite":"x"}');
    expect(grantArgs.acdc.said).toBe(CRED_SAID);
    expect(grantArgs.iss.said).toBe('EISSSAID');
    expect(grantArgs.anc.said).toBe(ANC_SAID);
    expect(m.submitGrant).toHaveBeenCalledWith(ISSUER, expect.anything(), ['sig'], '-end', [RECIPIENT]);

    // Personal issuer: no group witness gate, no member fan-out.
    expect(m.opGet).not.toHaveBeenCalled();
    expect(m.pushKelToAgent).toHaveBeenCalledTimes(1);
  });

  it('group issuer: waits for the anchoring ixn witness op and re-pushes the group KEL to other members before granting', async () => {
    const kc = new KERIClient();
    const calls: Calls = [];
    const m = makeClient(kc, {
      calls,
      issuer: { name: 'org-group', prefix: GROUP, group: { mhab: { prefix: 'DACTINGMEMBER' } } },
      cred: credRecord({ sad: { ...credRecord().sad, i: GROUP }, anc: { ...credRecord().anc, i: GROUP } }),
    });

    await kc.grantCredential('org-group', CRED_SAID, RECIPIENT);

    expect(m.opGet).toHaveBeenCalledWith(`group.${ANC_SAID}`);
    // Witness gate, then other-member push, then recipient push, then grant.
    expect(calls).toEqual([
      `credentials.get:${CRED_SAID}`,
      `operations.get:group.${ANC_SAID}`,
      `push:${GROUP}->DOTHERMEMBER`,
      `push:${GROUP}->${RECIPIENT}`,
      'grant',
      'submitGrant',
    ]);
    expect(m.submitGrant).toHaveBeenCalledWith(GROUP, expect.anything(), ['sig'], '-end', [RECIPIENT]);
  });

  it('fails loudly, without granting, when the stored credential lacks its anchoring event', async () => {
    const kc = new KERIClient();
    const calls: Calls = [];
    const m = makeClient(kc, { calls, cred: credRecord({ anc: undefined }) });

    await expect(kc.grantCredential('org', CRED_SAID, RECIPIENT)).rejects.toThrow(/cannot re-grant/);
    expect(m.grant).not.toHaveBeenCalled();
    expect(m.submitGrant).not.toHaveBeenCalled();
    expect(m.pushKelToAgent).not.toHaveBeenCalled();
  });

  it('propagates a KERIA 404 for a SAID that is no longer retrievable, without granting', async () => {
    const kc = new KERIClient();
    const calls: Calls = [];
    const m = makeClient(kc, { calls, cred: 'notfound' });

    await expect(kc.grantCredential('org', CRED_SAID, RECIPIENT)).rejects.toThrow(/404/);
    expect(m.grant).not.toHaveBeenCalled();
    expect(m.submitGrant).not.toHaveBeenCalled();
  });
});
