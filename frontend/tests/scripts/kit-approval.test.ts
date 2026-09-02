/**
 * Approval mode from the kit (coa-kit plan Task 8, issue #244).
 *
 * The pure helpers in src/kit/approval.ts turn a KitApproval into the
 * requirement grid the applicant sees, the endorsement/session gates the
 * steward applies, and the one-sentence description on the welcome screen.
 */
import { describe, it, expect } from 'vitest';
import {
  isOpen,
  requiredEndorsements,
  needsSession,
  needsAdmin,
  requirementsFor,
  approvalWords,
} from 'src/kit/approval';
import type { KitApproval } from 'src/kit/types';

const OPEN: KitApproval = { mode: 'open' };
const ADMIN: KitApproval = { mode: 'admin' };
const ENDORSE_2: KitApproval = { mode: 'endorsements', required: 2, admin: false };
const ENDORSE_SESSION_1: KitApproval = { mode: 'endorsements+session', required: 1, admin: true };

describe('kit approval predicates', () => {
  it('isOpen only for open mode', () => {
    expect(isOpen(OPEN)).toBe(true);
    expect(isOpen(ADMIN)).toBe(false);
    expect(isOpen(ENDORSE_SESSION_1)).toBe(false);
  });

  it('requiredEndorsements is 0 unless an endorsement mode', () => {
    expect(requiredEndorsements(OPEN)).toBe(0);
    expect(requiredEndorsements(ADMIN)).toBe(0);
    expect(requiredEndorsements(ENDORSE_2)).toBe(2);
    expect(requiredEndorsements(ENDORSE_SESSION_1)).toBe(1);
  });

  it('needsSession only for endorsements+session', () => {
    expect(needsSession(OPEN)).toBe(false);
    expect(needsSession(ENDORSE_2)).toBe(false);
    expect(needsSession(ENDORSE_SESSION_1)).toBe(true);
  });

  it('needsAdmin for admin mode and admin-flagged endorsement modes', () => {
    expect(needsAdmin(OPEN)).toBe(false);
    expect(needsAdmin(ADMIN)).toBe(true);
    expect(needsAdmin(ENDORSE_2)).toBe(false);
    expect(needsAdmin({ mode: 'endorsements', required: 2, admin: true })).toBe(true);
    expect(needsAdmin(ENDORSE_SESSION_1)).toBe(true);
  });
});

describe('requirementsFor', () => {
  it('open → no requirements', () => {
    expect(requirementsFor(OPEN)).toEqual([]);
  });

  it('admin → confirmation only', () => {
    expect(requirementsFor(ADMIN)).toEqual([
      { key: 'admin', title: 'Confirmation', description: 'From a community admin' },
    ]);
  });

  it('endorsements{2,false} → a single 2-endorsement requirement', () => {
    expect(requirementsFor(ENDORSE_2)).toEqual([
      { key: 'endorsement', title: '2 endorsements', description: 'From existing community members' },
    ]);
  });

  it('endorsements+session{1,true} → endorsement, session, admin (today’s three)', () => {
    expect(requirementsFor(ENDORSE_SESSION_1)).toEqual([
      { key: 'endorsement', title: 'Endorsement', description: 'From existing community members' },
      { key: 'session', title: 'Attendance', description: 'Whakawhanaunga session' },
      { key: 'admin', title: 'Confirmation', description: 'From a community admin' },
    ]);
  });
});

describe('approvalWords', () => {
  it('open', () => {
    expect(approvalWords(OPEN)).toBe('Anyone can join straight away.');
  });

  it('admin', () => {
    expect(approvalWords(ADMIN)).toBe('An admin approves each new member.');
  });

  it('endorsements (plural, no admin)', () => {
    expect(approvalWords(ENDORSE_2)).toBe(
      'New members need 2 endorsements from existing members.',
    );
  });

  it('endorsements (singular, with admin)', () => {
    expect(approvalWords({ mode: 'endorsements', required: 1, admin: true })).toBe(
      'New members need 1 endorsement from existing members, then an admin confirms.',
    );
  });

  it('endorsements+session (singular, with admin)', () => {
    expect(approvalWords(ENDORSE_SESSION_1)).toBe(
      'New members need 1 endorsement and attend a whakawhanaungatanga session before an admin confirms them.',
    );
  });
});
