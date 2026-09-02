// Pure helpers that turn the kit's approval mode into the shapes the applicant's
// PendingApprovalScreen (requirement grid + booking card), the steward's
// ProfileModal gate and the KitWelcomeScreen sentence all share. Kept DOM-free
// so they unit-test without a component (see tests/scripts/kit-approval.test.ts).
import type { KitApproval } from './types';

export type RequirementKey = 'endorsement' | 'admin' | 'session';
export interface Requirement {
  key: RequirementKey;
  title: string;
  description: string;
}

/** No requirements — anyone joins straight away. */
export const isOpen = (a: KitApproval) => a.mode === 'open';

/** Endorsements the applicant must collect (0 for open/admin modes). */
export const requiredEndorsements = (a: KitApproval) =>
  a.mode === 'endorsements' || a.mode === 'endorsements+session' ? a.required : 0;

/** Whether a whakawhanaungatanga session is part of the flow. */
export const needsSession = (a: KitApproval) => a.mode === 'endorsements+session';

/** Whether an admin confirmation is required (always for admin mode, opt-in for endorsement modes). */
export const needsAdmin = (a: KitApproval) =>
  a.mode === 'admin' ||
  ((a.mode === 'endorsements' || a.mode === 'endorsements+session') && a.admin);

/** Ordered requirement cards for the applicant's pending screen. */
export function requirementsFor(a: KitApproval): Requirement[] {
  const r: Requirement[] = [];
  const n = requiredEndorsements(a);
  if (n > 0)
    r.push({
      key: 'endorsement',
      title: n === 1 ? 'Endorsement' : `${n} endorsements`,
      description: 'From existing community members',
    });
  if (needsSession(a)) r.push({ key: 'session', title: 'Attendance', description: 'Whakawhanaunga session' });
  if (needsAdmin(a)) r.push({ key: 'admin', title: 'Confirmation', description: 'From a community admin' });
  return r;
}

/** One-sentence description of the kit's approval mode. */
export function approvalWords(a: KitApproval): string {
  switch (a.mode) {
    case 'open':
      return 'Anyone can join straight away.';
    case 'admin':
      return 'An admin approves each new member.';
    case 'endorsements':
      return `New members need ${a.required} endorsement${a.required === 1 ? '' : 's'} from existing members${a.admin ? ', then an admin confirms' : ''}.`;
    case 'endorsements+session':
      return `New members need ${a.required} endorsement${a.required === 1 ? '' : 's'} and attend a whakawhanaungatanga session${a.admin ? ' before an admin confirms them' : ''}.`;
  }
}
