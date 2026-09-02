// Pure helpers that turn the kit's profile config (interest labels + custom
// questions) into the shapes the registration form, the EXN payload and the
// steward's ProfileModal all share. Kept DOM-free so they unit-test without a
// component (see tests/scripts/kit-profile-form.test.ts).
import type { KitCustomQuestion, KitProfile } from './types';

export interface InterestOption {
  value: string;
  label: string;
  description: string;
}

/** One applicant answer to a kit custom question, carried by label. */
export interface CustomAnswer {
  label: string;
  value: string | string[];
}

/** Stable slug for an interest label: lowercase, non-alphanumerics → '_'. */
export const slugifyInterest = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** Interest checkbox options derived from the kit's interest labels. */
export function interestOptions(p: KitProfile): InterestOption[] {
  return p.interestOptions.map((label) => ({ value: slugifyInterest(label), label, description: '' }));
}

/** Blank answers for a set of custom questions ([] for multiselect, '' otherwise). */
export function emptyAnswers(qs: KitCustomQuestion[]): CustomAnswer[] {
  return qs.map((q) => ({ label: q.label, value: q.type === 'multiselect' ? [] : '' }));
}

/** Whether the given answers are valid for their question types. */
export function answersValid(qs: KitCustomQuestion[], answers: CustomAnswer[]): boolean {
  return qs.every((q, i) => {
    const v = answers[i]?.value;
    return q.type === 'text'
      ? typeof v === 'string' && v.length <= 500
      : q.type === 'select'
        ? v === '' || (typeof v === 'string' && q.options.includes(v))
        : Array.isArray(v) && v.every((x) => q.options.includes(x));
  });
}
