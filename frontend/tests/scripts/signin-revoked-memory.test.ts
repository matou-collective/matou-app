/**
 * What the wallet remembers of a door's `revoked` answer (#690): a fact about
 * ONE credential SAID, as ONE sign-in site read it — held in memory for the
 * unlocked session, cleared when that SAID is read as live, and dropped whole
 * on lock or exit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  answeredByTheDoor,
  asTheDoorReadThem,
  rememberRevoked,
  isRememberedRevoked,
  forgetRevoked,
  clearRevokedMemory,
} from 'src/lib/signin/revokedMemory';
import type { HeldCredential } from 'src/lib/signin/credential';

const HOME = 'https://id.home.nz/login';
const OTHER = 'https://id.other.nz/login';

beforeEach(() => {
  clearRevokedMemory();
});

describe('the revoked memory', () => {
  it('remembers nothing until a door has answered', () => {
    expect(isRememberedRevoked(HOME, 'EAdministratorSAID')).toBe(false);
  });

  it('remembers the one credential the door answered `revoked` to, and no other', () => {
    rememberRevoked(HOME, 'EAdministratorSAID');
    expect(isRememberedRevoked(HOME, 'EAdministratorSAID')).toBe(true);
    expect(isRememberedRevoked(HOME, 'EMembershipSAID')).toBe(false);
  });

  it('is what ONE sign-in site said: no other site is believed to have said it', () => {
    rememberRevoked(OTHER, 'EAdministratorSAID');
    expect(isRememberedRevoked(OTHER, 'EAdministratorSAID')).toBe(true);
    expect(isRememberedRevoked(HOME, 'EAdministratorSAID')).toBe(false);
  });

  it('knows a sign-in site by its address, with or without the trailing slash', () => {
    rememberRevoked(`${HOME}/`, 'EAdministratorSAID');
    expect(isRememberedRevoked(HOME, 'EAdministratorSAID')).toBe(true);
    expect(isRememberedRevoked(` ${HOME} `, 'EAdministratorSAID')).toBe(true);
  });

  it('is cleared for a credential later read as live — at every site, and only for that one', () => {
    rememberRevoked(HOME, 'EAdministratorSAID');
    rememberRevoked(OTHER, 'EAdministratorSAID');
    rememberRevoked(HOME, 'EFinanceSAID');
    forgetRevoked('EAdministratorSAID');
    expect(isRememberedRevoked(HOME, 'EAdministratorSAID')).toBe(false);
    expect(isRememberedRevoked(OTHER, 'EAdministratorSAID')).toBe(false);
    expect(isRememberedRevoked(HOME, 'EFinanceSAID')).toBe(true);
  });

  it('is dropped whole on lock or exit', () => {
    rememberRevoked(HOME, 'EAdministratorSAID');
    rememberRevoked(OTHER, 'EFinanceSAID');
    clearRevokedMemory();
    expect(isRememberedRevoked(HOME, 'EAdministratorSAID')).toBe(false);
    expect(isRememberedRevoked(OTHER, 'EFinanceSAID')).toBe(false);
  });

  it.each([
    ['a blank SAID', ''],
    ['no SAID', undefined],
    ['a null SAID', null],
  ])('never remembers %s — a credential with no SAID is not every such credential', (_case, said) => {
    rememberRevoked(HOME, said as unknown as string);
    expect(isRememberedRevoked(HOME, said)).toBe(false);
    expect(isRememberedRevoked(HOME, '')).toBe(false);
    expect(isRememberedRevoked(HOME, undefined)).toBe(false);
  });

  it.each([
    ['a blank address', ''],
    ['no address', undefined],
  ])('never remembers anything of a site with %s', (_case, door) => {
    rememberRevoked(door as unknown as string, 'EAdministratorSAID');
    expect(isRememberedRevoked(door as unknown as string, 'EAdministratorSAID')).toBe(false);
    expect(isRememberedRevoked(HOME, 'EAdministratorSAID')).toBe(false);
  });
});

// Only the sign-in site's own answer is heard. A code names the site (`door`)
// and, apart from it, where to post (`present`); an answer from anywhere but
// the site itself says nothing the wallet remembers.
describe('answeredByTheDoor', () => {
  it('is true when the answer came from the sign-in site itself', () => {
    expect(answeredByTheDoor(HOME, 'https://id.home.nz/login/app/present')).toBe(true);
    expect(answeredByTheDoor('https://id.home.nz', 'https://id.home.nz/login/app/present')).toBe(true);
    expect(answeredByTheDoor('http://127.0.0.1:8099/login', 'http://127.0.0.1:8099/login/app/present')).toBe(true);
  });

  it.each([
    ['another host', 'https://evil.example/present'],
    ['a host that only starts the same', 'https://id.home.nz.evil.example/login/app/present'],
    ['another port', 'https://id.home.nz:8443/login/app/present'],
    ['another scheme', 'http://id.home.nz/login/app/present'],
    ['no address at all', ''],
    ['something that is not an address', 'not a url'],
  ])('is false when it came from %s', (_case, present) => {
    expect(answeredByTheDoor(HOME, present)).toBe(false);
  });

  it('is false when the sign-in site itself has no readable address', () => {
    expect(answeredByTheDoor('', 'https://id.home.nz/login/app/present')).toBe(false);
    expect(answeredByTheDoor('not a url', 'not a url')).toBe(false);
  });
});

// The held credentials, as this sign-in site read them: one it answered
// `revoked` to wears the standing the agent gives a revoked credential, so
// every reader of a credential's standing agrees without asking the memory.
describe('asTheDoorReadThem', () => {
  const administrator: HeldCredential = {
    sad: { d: 'EAdministratorSAID', s: 'ECo', a: { i: 'EHolder', committee: 'administrator' } },
    status: { s: '0', et: 'iss' },
  };
  const membership: HeldCredential = {
    sad: { d: 'EMembershipSAID', s: 'EMe', a: { i: 'EHolder', role: 'operator' } },
    status: { s: '0', et: 'iss' },
  };

  it('hands back every credential untouched when the site has said nothing', () => {
    const read = asTheDoorReadThem([administrator, membership], HOME);
    expect(read).toHaveLength(2);
    expect(read[0]).toBe(administrator);
    expect(read[1]).toBe(membership);
  });

  it('marks the one the site called revoked, and leaves the rest as they were', () => {
    rememberRevoked(HOME, 'EAdministratorSAID');
    const read = asTheDoorReadThem([administrator, membership], HOME);
    expect(read[0]!.sad).toBe(administrator.sad);
    expect(read[0]!.status).toMatchObject({ s: '1', et: 'rev' });
    expect(read[1]).toBe(membership);
  });

  it('never changes the credential it was given', () => {
    rememberRevoked(HOME, 'EAdministratorSAID');
    asTheDoorReadThem([administrator], HOME);
    expect(administrator.status).toEqual({ s: '0', et: 'iss' });
  });

  it('marks nothing for a site that did not say it', () => {
    rememberRevoked(OTHER, 'EAdministratorSAID');
    expect(asTheDoorReadThem([administrator, membership], HOME)[0]).toBe(administrator);
  });

  it('keeps the order the wallet holds them in', () => {
    rememberRevoked(HOME, 'EMembershipSAID');
    const read = asTheDoorReadThem([administrator, membership], HOME);
    expect(read.map((c) => c.sad?.d)).toEqual(['EAdministratorSAID', 'EMembershipSAID']);
  });
});
