import { describe, it, expect, vi } from 'vitest';
import {
  claimNotification,
  grantCredentialSaid,
  isGrantAlreadyAdmitted,
  isCredentialAlreadyIssued,
  isCredentialRevoked,
  isAlreadyGroupSigner,
  type ClaimableNote,
  type CredentialListOptions,
  type WalletCredential,
} from 'src/lib/keri/notifications';

// --- Mock SignifyClient builders -------------------------------------------

function notifClient(opts: {
  markImpl?: (id: string) => Promise<void>;
  listNotes: () => ClaimableNote[];
  listImpl?: () => Promise<{ notes?: ClaimableNote[] }>;
}) {
  const mark = vi.fn(opts.markImpl ?? (async () => {}));
  const list = vi.fn(
    opts.listImpl ?? (async () => ({ notes: opts.listNotes() })),
  );
  return {
    mark,
    list,
    notifications: () => ({ list, mark }),
  };
}

/**
 * Emulates KERIA's `POST /credentials/query` the way signify-ts drives it:
 * Seeker equality filters keyed by CESR path (`-d` SAID, `-s` schema, `-a-i`
 * issuee) and — the part that bit #480 — signify-ts's default `limit` of 25
 * when the caller passes none. A mock that returned the whole wallet would let
 * an unfiltered lookup pass here while silently truncating in production.
 */
function keriaQuery(creds: WalletCredential[], kargs?: CredentialListOptions): WalletCredential[] {
  const filter = (kargs?.filter ?? {}) as Record<string, unknown>;
  const path = (c: WalletCredential, key: string): unknown => {
    switch (key) {
      case '-d':
        return c.sad?.d ?? c.d;
      case '-s':
        return c.sad?.s;
      case '-a-i':
        return c.sad?.a?.i;
      default:
        throw new Error(`unexpected filter key ${key}`);
    }
  };
  const matched = creds.filter((c) => Object.entries(filter).every(([k, v]) => path(c, k) === v));
  const limit = kargs?.limit ?? 25;
  return matched.slice(kargs?.skip ?? 0, (kargs?.skip ?? 0) + limit);
}

function credClient(creds: WalletCredential[], opts: { throws?: boolean } = {}) {
  const list = vi.fn(async (kargs?: CredentialListOptions) => {
    if (opts.throws) throw new Error('KERIA unreachable');
    return keriaQuery(creds, kargs);
  });
  return { list, credentials: () => ({ list }) };
}

/** `n` unrelated credentials, enough to overflow signify-ts's default page. */
function filler(n: number): WalletCredential[] {
  return Array.from({ length: n }, (_, i) => ({
    sad: { d: `EFILL${i}`, s: `ESCHEMA_filler`, a: { i: `DMEMBER${i}` } },
    status: { et: 'iss', s: '0' },
  }));
}

const grantOf = (said: string) => ({ exn: { e: { acdc: { d: said } } } });

// --- claimNotification ------------------------------------------------------

describe('claimNotification (issue #470)', () => {
  it('marks read then proceeds when the note reads as handled after the mark', async () => {
    const note: ClaimableNote = { i: 'AAAnote', r: false, a: { r: '/x' } };
    // The re-list reflects the mark: the note now reads read=true.
    const client = notifClient({ listNotes: () => [{ ...note, r: true }] });

    const proceed = await claimNotification(client, note);

    expect(proceed).toBe(true);
    expect(client.mark).toHaveBeenCalledWith('AAAnote');
  });

  it('does not proceed when the note is still unread after the mark', async () => {
    const note: ClaimableNote = { i: 'AAAnote', r: false };
    // Mark silently no-ops (eventual consistency) — re-list still shows unread.
    const client = notifClient({ listNotes: () => [{ ...note, r: false }] });

    expect(await claimNotification(client, note)).toBe(false);
  });

  it('does not proceed when the note has vanished from the list (handled elsewhere)', async () => {
    const note: ClaimableNote = { i: 'AAAnote', r: false };
    const client = notifClient({ listNotes: () => [] });

    expect(await claimNotification(client, note)).toBe(false);
  });

  it('never throws and does not proceed when the re-list fails', async () => {
    const note: ClaimableNote = { i: 'AAAnote', r: false };
    const client = notifClient({
      listNotes: () => [],
      listImpl: async () => {
        throw new Error('list failed');
      },
    });

    expect(await claimNotification(client, note)).toBe(false);
  });

  it('still re-checks state when the mark itself throws', async () => {
    const note: ClaimableNote = { i: 'AAAnote', r: false };
    const client = notifClient({
      markImpl: async () => {
        throw new Error('mark failed');
      },
      // Another client had already marked it read before our failed mark.
      listNotes: () => [{ ...note, r: true }],
    });

    expect(await claimNotification(client, note)).toBe(true);
  });
});

// --- grantCredentialSaid ----------------------------------------------------

describe('grantCredentialSaid', () => {
  it('extracts the embedded ACDC SAID from a grant exchange', () => {
    expect(grantCredentialSaid(grantOf('ECRED123'))).toBe('ECRED123');
  });

  it('returns undefined for an unexpected shape', () => {
    expect(grantCredentialSaid(null)).toBeUndefined();
    expect(grantCredentialSaid(undefined)).toBeUndefined();
    expect(grantCredentialSaid({ exn: {} })).toBeUndefined();
    expect(grantCredentialSaid({ exn: { e: {} } })).toBeUndefined();
  });
});

// --- isGrantAlreadyAdmitted -------------------------------------------------

describe('isGrantAlreadyAdmitted (IPEX admit idempotency, issue #470)', () => {
  it('is true when the grant credential is already in the wallet → no admit', async () => {
    const client = credClient([{ sad: { d: 'ECRED123' } }, { sad: { d: 'EOTHER' } }]);

    expect(await isGrantAlreadyAdmitted(client, grantOf('ECRED123'))).toBe(true);
  });

  it('is false when the grant credential is not yet in the wallet → admit proceeds', async () => {
    const client = credClient([{ sad: { d: 'EOTHER' } }]);

    expect(await isGrantAlreadyAdmitted(client, grantOf('ECRED123'))).toBe(false);
  });

  it('matches credentials keyed by a bare `d` as well as `sad.d`', async () => {
    const client = credClient([{ d: 'ECRED123' }]);

    expect(await isGrantAlreadyAdmitted(client, grantOf('ECRED123'))).toBe(true);
  });

  it('is false (proceeds) when the grant SAID cannot be read', async () => {
    const client = credClient([{ sad: { d: 'ECRED123' } }]);

    expect(await isGrantAlreadyAdmitted(client, { exn: {} })).toBe(false);
    expect(client.list).not.toHaveBeenCalled();
  });

  it('never throws and proceeds when the credential list fails', async () => {
    const client = credClient([], { throws: true });

    expect(await isGrantAlreadyAdmitted(client, grantOf('ECRED123'))).toBe(false);
  });

  it('still finds the credential when the wallet holds more than signify-ts\'s default page of 25', async () => {
    // The already-admitted credential sits at position 31: an unfiltered
    // list() would never return it and the second admit would go ahead.
    const client = credClient([...filler(30), { sad: { d: 'ECRED123' } }]);

    expect(await isGrantAlreadyAdmitted(client, grantOf('ECRED123'))).toBe(true);
    expect(client.list).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.objectContaining({ '-d': 'ECRED123' }) }),
    );
  });
});

// --- isCredentialAlreadyIssued ----------------------------------------------

const SCHEMA = 'ESCHEMA_membership';
const ISSUEE = 'DAPPLICANT';

const issuedCredClient = credClient;
const issued = (d: string, s: string, i: string): WalletCredential => ({
  sad: { d, s, a: { i } },
  status: { et: 'iss', s: '0' },
});
const revoked = (d: string, s: string, i: string): WalletCredential => ({
  sad: { d, s, a: { i } },
  status: { et: 'rev', s: '1' },
});

describe('isCredentialAlreadyIssued (approval idempotency, issue #480)', () => {
  it('is true when a credential of the schema is already issued to the applicant → skip issuance', async () => {
    const client = issuedCredClient([
      { sad: { d: 'EX', s: 'EOTHER', a: { i: ISSUEE } } },
      { sad: { d: 'EY', s: SCHEMA, a: { i: ISSUEE } } },
    ]);

    expect(await isCredentialAlreadyIssued(client, SCHEMA, ISSUEE)).toBe(true);
  });

  it('is false when no credential matches BOTH schema and issuee → issuance proceeds', async () => {
    const client = issuedCredClient([
      { sad: { d: 'EX', s: SCHEMA, a: { i: 'DOTHERAPPLICANT' } } },
      { sad: { d: 'EY', s: 'EOTHER', a: { i: ISSUEE } } },
    ]);

    expect(await isCredentialAlreadyIssued(client, SCHEMA, ISSUEE)).toBe(false);
  });

  it('is false when the wallet is empty → first approval proceeds', async () => {
    const client = issuedCredClient([]);

    expect(await isCredentialAlreadyIssued(client, SCHEMA, ISSUEE)).toBe(false);
  });

  it('is false (proceeds) without listing when schema or issuee is blank', async () => {
    const client = issuedCredClient([{ sad: { d: 'EY', s: SCHEMA, a: { i: ISSUEE } } }]);

    expect(await isCredentialAlreadyIssued(client, '', ISSUEE)).toBe(false);
    expect(await isCredentialAlreadyIssued(client, SCHEMA, '')).toBe(false);
    expect(client.list).not.toHaveBeenCalled();
  });

  it('never throws and proceeds when the credential list fails', async () => {
    const client = issuedCredClient([], { throws: true });

    expect(await isCredentialAlreadyIssued(client, SCHEMA, ISSUEE)).toBe(false);
  });

  it('queries KERIA filtered on issuee + schema, so a wallet past the default page of 25 still hits', async () => {
    // The org agent's wallet holds every credential it ever issued. With the
    // applicant's membership credential at position 31 an unfiltered list()
    // returns only the first 25 and the guard silently never fires.
    const client = issuedCredClient([...filler(30), issued('EY', SCHEMA, ISSUEE)]);

    expect(await isCredentialAlreadyIssued(client, SCHEMA, ISSUEE)).toBe(true);
    expect(client.list).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.objectContaining({ '-a-i': ISSUEE, '-s': SCHEMA }) }),
    );
  });

  it('is false when the only matching credential is revoked → a removed member can be re-approved', async () => {
    const client = issuedCredClient([revoked('EOLD', SCHEMA, ISSUEE)]);

    expect(await isCredentialAlreadyIssued(client, SCHEMA, ISSUEE)).toBe(false);
  });

  it('is true when a revoked credential was superseded by an active re-issue (role change)', async () => {
    const client = issuedCredClient([revoked('EOLD', SCHEMA, ISSUEE), issued('ENEW', SCHEMA, ISSUEE)]);

    expect(await isCredentialAlreadyIssued(client, SCHEMA, ISSUEE)).toBe(true);
  });
});

// --- isCredentialRevoked ----------------------------------------------------

describe('isCredentialRevoked', () => {
  it('reads the TEL event ilk when present', () => {
    expect(isCredentialRevoked({ status: { et: 'rev', s: '1' } })).toBe(true);
    expect(isCredentialRevoked({ status: { et: 'brv', s: '1' } })).toBe(true);
    expect(isCredentialRevoked({ status: { et: 'iss', s: '0' } })).toBe(false);
    expect(isCredentialRevoked({ status: { et: 'bis', s: '0' } })).toBe(false);
  });

  it('falls back to the TEL sequence number when the ilk is absent', () => {
    expect(isCredentialRevoked({ status: { s: '1' } })).toBe(true);
    expect(isCredentialRevoked({ status: { s: '0' } })).toBe(false);
  });

  it('treats a missing status as not revoked', () => {
    expect(isCredentialRevoked({})).toBe(false);
    expect(isCredentialRevoked(undefined)).toBe(false);
  });
});

// --- isAlreadyGroupSigner ---------------------------------------------------

describe('isAlreadyGroupSigner (multisig idempotency, issue #470)', () => {
  it('is true when our current key is already a group signing key → no join', () => {
    expect(isAlreadyGroupSigner(['DADMIN', 'DME'], ['DME'])).toBe(true);
  });

  it('is false when our key is not yet a group signing key → join proceeds', () => {
    expect(isAlreadyGroupSigner(['DADMIN'], ['DME'])).toBe(false);
  });

  it('is false when either key set is empty or missing', () => {
    expect(isAlreadyGroupSigner([], ['DME'])).toBe(false);
    expect(isAlreadyGroupSigner(['DME'], [])).toBe(false);
    expect(isAlreadyGroupSigner(undefined, ['DME'])).toBe(false);
    expect(isAlreadyGroupSigner(['DME'], undefined)).toBe(false);
  });
});
