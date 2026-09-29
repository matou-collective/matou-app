/**
 * What the wallet remembers of a door's `revoked` answer (#690): a fact about
 * ONE credential SAID, held in memory for the unlocked session, cleared when
 * that SAID is read as live, and dropped whole on lock or exit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  rememberRevoked,
  isRememberedRevoked,
  forgetRevoked,
  clearRevokedMemory,
} from 'src/lib/signin/revokedMemory';

beforeEach(() => {
  clearRevokedMemory();
});

describe('the revoked memory', () => {
  it('remembers nothing until a door has answered', () => {
    expect(isRememberedRevoked('EAdministratorSAID')).toBe(false);
  });

  it('remembers the one credential the door answered `revoked` to, and no other', () => {
    rememberRevoked('EAdministratorSAID');
    expect(isRememberedRevoked('EAdministratorSAID')).toBe(true);
    expect(isRememberedRevoked('EMembershipSAID')).toBe(false);
  });

  it('is cleared for a credential later read as live, and only for that one', () => {
    rememberRevoked('EAdministratorSAID');
    rememberRevoked('EFinanceSAID');
    forgetRevoked('EAdministratorSAID');
    expect(isRememberedRevoked('EAdministratorSAID')).toBe(false);
    expect(isRememberedRevoked('EFinanceSAID')).toBe(true);
  });

  it('is dropped whole on lock or exit', () => {
    rememberRevoked('EAdministratorSAID');
    rememberRevoked('EFinanceSAID');
    clearRevokedMemory();
    expect(isRememberedRevoked('EAdministratorSAID')).toBe(false);
    expect(isRememberedRevoked('EFinanceSAID')).toBe(false);
  });

  it.each([
    ['a blank SAID', ''],
    ['no SAID', undefined],
    ['a null SAID', null],
  ])('never remembers %s — a credential with no SAID is not every such credential', (_case, said) => {
    rememberRevoked(said as unknown as string);
    expect(isRememberedRevoked(said)).toBe(false);
    expect(isRememberedRevoked('')).toBe(false);
    expect(isRememberedRevoked(undefined)).toBe(false);
  });
});
