/**
 * Choosing, describing and trimming the presented credential (idss #1492
 * stories 13/14, ADR 0236 §2). The single-match line names kind, role and
 * issue date; the export is trimmed to the ACDC and its iss, dropping the KEL
 * noise the door reads from the witnessed ledger itself.
 */
import { describe, it, expect } from 'vitest';
import {
  chooseCredential,
  describeCredential,
  trimPresentation,
  formatIssueDate,
  type HeldCredential,
} from 'src/lib/signin/credential';

const MEMBERSHIP = 'EMembershipSchemaSAID';
const HOLDER = 'EHolderAID';

const membershipCred: HeldCredential = {
  sad: { d: 'ECredSAID', s: MEMBERSHIP, i: 'EIssuer', a: { i: HOLDER, role: 'Member', dt: '2026-08-12T00:00:00Z' } },
};

describe('chooseCredential', () => {
  it('picks the credential of the asked schema held by this member', () => {
    const other: HeldCredential = { sad: { d: 'EOther', s: 'EOtherSchema', a: { i: HOLDER } } };
    expect(chooseCredential([other, membershipCred], [MEMBERSHIP], HOLDER)).toBe(membershipCred);
  });

  it('does not present a credential issued to someone else', () => {
    const someoneElse: HeldCredential = { sad: { d: 'EX', s: MEMBERSHIP, a: { i: 'ESomeoneElse' } } };
    expect(chooseCredential([someoneElse], [MEMBERSHIP], HOLDER)).toBeUndefined();
  });

  it('falls back to the first credential when the ask names no schema', () => {
    expect(chooseCredential([membershipCred], [], HOLDER)).toBe(membershipCred);
  });

  it('returns undefined when nothing matches the asked schema', () => {
    expect(chooseCredential([membershipCred], ['ENope'], HOLDER)).toBeUndefined();
  });
});

describe('describeCredential', () => {
  it('names the kind, role and issue date', () => {
    const shown = describeCredential(membershipCred, { [MEMBERSHIP]: 'membership' });
    expect(shown).toEqual({
      said: 'ECredSAID',
      schema: MEMBERSHIP,
      kindLabel: 'Membership',
      role: 'Member',
      issuedOn: '12 Aug 2026',
    });
  });

  it('title-cases an unknown kind key and defaults when unmapped', () => {
    expect(describeCredential(membershipCred, { [MEMBERSHIP]: 'kaitiaki' }).kindLabel).toBe('Kaitiaki');
    expect(describeCredential(membershipCred, {}).kindLabel).toBe('Membership');
  });
});

describe('formatIssueDate', () => {
  it('formats an ISO date and tolerates junk', () => {
    expect(formatIssueDate('2026-08-12T09:30:00Z')).toBe('12 Aug 2026');
    expect(formatIssueDate('not-a-date')).toBe('');
    expect(formatIssueDate(undefined)).toBe('');
  });
});

// Build a CESR message whose version-string size field matches its byte length
// (KERI "sizeify"); replacing the 6-char placeholder keeps the length stable.
function sizeify(proto: 'ACDC' | 'KERI', fields: Record<string, unknown>): string {
  const withV = { v: `${proto}10JSON000000_`, ...fields };
  const size = new TextEncoder().encode(JSON.stringify(withV)).length;
  withV.v = `${proto}10JSON${size.toString(16).padStart(6, '0')}_`;
  return JSON.stringify(withV);
}

describe('trimPresentation', () => {
  const icp = sizeify('KERI', { t: 'icp', d: 'Eicp', i: 'Eissuer', s: '0' });
  const acdc = sizeify('ACDC', { d: 'Ecred', i: 'Eissuer', ri: 'Ereg', s: MEMBERSHIP, a: { i: HOLDER } });
  const iss = sizeify('KERI', { t: 'iss', d: 'Eiss', i: 'Ecred', s: '0', ri: 'Ereg' });

  it('keeps only the ACDC and its iss, dropping KEL messages', () => {
    const trimmed = trimPresentation(icp + acdc + iss + icp);
    expect(trimmed).toBe(acdc + iss);
  });

  it('returns the full stream unchanged when both messages are not found', () => {
    const onlyAcdc = icp + acdc;
    expect(trimPresentation(onlyAcdc)).toBe(onlyAcdc);
  });
});
