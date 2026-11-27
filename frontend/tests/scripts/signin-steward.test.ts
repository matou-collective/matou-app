/**
 * Whether the wallet's identity is one of the community's stewards (#688, idss
 * ADR 0282 as amended 2026-09-29, ruling 3). The wallet decides whether there is
 * a seat to unlock, and reads it in ONE place: a held Membership whose `role` is
 * `operator`. idss #1956 removes `role`; what replaces this reading is that
 * ticket's concern — it changes here and nowhere else.
 */
import { describe, it, expect } from 'vitest';
import { identityIsSteward } from 'src/lib/signin/steward';
import type { HeldCredential } from 'src/lib/signin/credential';

const HOLDER = 'EHa';
const SCHEMAS = ['ECo', 'EMe'];

const member: HeldCredential = {
  sad: { d: 'EMember', s: 'EMe', i: 'ECommunity', a: { i: HOLDER, role: 'Member' } },
};
const operator: HeldCredential = {
  sad: { d: 'EOperator', s: 'EMe', i: 'ECommunity', a: { i: HOLDER, role: 'operator' } },
};
const administrator: HeldCredential = {
  sad: { d: 'EAdministrator', s: 'ECo', i: 'ECommunity', a: { i: HOLDER, committee: 'administrator' } },
  status: { s: '0', et: 'iss' },
};

describe('identityIsSteward', () => {
  it('a wallet presenting nothing is no steward', () => {
    expect(identityIsSteward(null, [operator], SCHEMAS, HOLDER)).toBe(false);
  });

  it('an operator presenting their Membership is a steward, whatever the case of the role', () => {
    expect(identityIsSteward(operator, [operator], SCHEMAS, HOLDER)).toBe(true);
    const shouted: HeldCredential = { sad: { ...operator.sad, a: { ...operator.sad!.a, role: ' Operator ' } } };
    expect(identityIsSteward(shouted, [shouted], SCHEMAS, HOLDER)).toBe(true);
  });

  it('a member presenting their Membership is not', () => {
    expect(identityIsSteward(member, [member], SCHEMAS, HOLDER)).toBe(false);
  });

  it('a steward presenting Administrator is a steward by the operator Membership they hold', () => {
    expect(identityIsSteward(administrator, [operator, administrator], SCHEMAS, HOLDER)).toBe(true);
  });

  it('holding Administrator makes nobody a steward', () => {
    expect(identityIsSteward(administrator, [administrator], SCHEMAS, HOLDER)).toBe(false);
    expect(identityIsSteward(administrator, [member, administrator], SCHEMAS, HOLDER)).toBe(false);
  });

  it.each([
    ['revoked', { sad: operator.sad, status: { s: '1', et: 'rev' } } as HeldCredential],
    ['of a schema the door did not ask for', { sad: { ...operator.sad, s: 'EElsewhere' } } as HeldCredential],
    ["someone else's", { sad: { ...operator.sad, a: { i: 'ESomeoneElse', role: 'operator' } } } as HeldCredential],
    [
      'a komiti credential that claims the role',
      { sad: { d: 'EKomiti', s: 'ECo', a: { i: HOLDER, committee: 'finance', role: 'operator' } } } as HeldCredential,
    ],
  ])('an operator Membership that is %s lends no standing', (_case, notStanding) => {
    expect(identityIsSteward(administrator, [notStanding, administrator], SCHEMAS, HOLDER)).toBe(false);
  });
});
