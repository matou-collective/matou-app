/**
 * Normalizers for a contribution's planning fields (Budget, Estimated Hours)
 * as the create/edit form submits them. See #747.
 *
 * The bug these guard against: clearing one of these fields on an existing
 * contribution and saving silently reverted to the old value, while the UI
 * still reported "Contribution updated!". The cause was the submit builder
 * dropping an emptied field instead of sending the cleared value:
 *
 *   - an emptied Budget was coerced to `undefined` (`x.trim() || undefined`),
 *     so `JSON.stringify` dropped the key and the backend kept the old value;
 *   - an emptied Estimated Hours `<input type="number">` yields `""` (Vue's
 *     `.number` modifier keeps an unparsable string), which failed the
 *     backend's `float64` type guard and was likewise ignored.
 *
 * Clearing is an honest, persisted action: Budget (a free-text string) clears
 * to `""`, and Estimated Hours (an int with no "unset" representation) clears
 * to `0`. Both values must reach the backend so they overwrite the old value.
 */

/**
 * Coerce an Estimated Hours input to a non-negative integer. An emptied number
 * input (`""`, `undefined`, `null`, or `NaN`) becomes `0` so clearing the field
 * persists `0` rather than being dropped. A fractional value is truncated to
 * match the integer model.
 */
export function normalizeEstimatedHours(v: number | string | undefined | null): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

/**
 * Normalize a Budget input to a trimmed string. An emptied field becomes `""`
 * (never `undefined`) so the cleared value is sent and persisted, not dropped.
 */
export function normalizeContributionBudget(v: string | undefined | null): string {
  return (v ?? '').trim();
}
