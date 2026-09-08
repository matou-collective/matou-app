import { describe, it, expect, vi } from 'vitest';
import {
  claimNotification,
  grantCredentialSaid,
  isGrantAlreadyAdmitted,
  isAlreadyGroupSigner,
  type ClaimableNote,
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

function credClient(creds: Array<{ sad?: { d?: string }; d?: string }>, opts: { throws?: boolean } = {}) {
  const list = vi.fn(async () => {
    if (opts.throws) throw new Error('KERIA unreachable');
    return creds;
  });
  return { list, credentials: () => ({ list }) };
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
