/**
 * #747 — Editing a contribution's Budget or Estimated Hours to empty must
 * persist the cleared value, not silently revert.
 *
 * Root cause was the create/edit submit builder:
 *   - an emptied Budget was coerced to `undefined` (`x.trim() || undefined`),
 *     so `JSON.stringify` dropped the key and the backend kept the old value;
 *   - an emptied Estimated Hours number input yields `""`, which failed the
 *     backend's `float64` guard and was likewise ignored.
 *
 * The normalizers below are what the fixed builders use. They encode the
 * ruling: clearing is honest and persisted — Budget clears to `""`, Estimated
 * Hours clears to `0`.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeEstimatedHours,
  normalizeContributionBudget,
} from '../../src/lib/contributionPlanning';

describe('#747 normalizeEstimatedHours', () => {
  it('coerces an emptied number input ("") to 0 so the clear persists', () => {
    // Vue's `.number` modifier keeps an unparsable string, so a cleared
    // `<input type="number">` surfaces as "" at submit time.
    expect(normalizeEstimatedHours('')).toBe(0);
  });

  it('coerces undefined / null / NaN to 0', () => {
    expect(normalizeEstimatedHours(undefined)).toBe(0);
    expect(normalizeEstimatedHours(null)).toBe(0);
    expect(normalizeEstimatedHours(NaN)).toBe(0);
  });

  it('keeps an explicit 0', () => {
    expect(normalizeEstimatedHours(0)).toBe(0);
  });

  it('passes through a positive integer', () => {
    expect(normalizeEstimatedHours(40)).toBe(40);
    expect(normalizeEstimatedHours('12')).toBe(12);
  });

  it('truncates a fractional value to match the integer model', () => {
    expect(normalizeEstimatedHours(3.7)).toBe(3);
  });

  it('clamps a negative value to 0', () => {
    expect(normalizeEstimatedHours(-5)).toBe(0);
  });
});

describe('#747 normalizeContributionBudget', () => {
  it('returns "" (not undefined) for a cleared field so the clear is sent', () => {
    expect(normalizeContributionBudget('')).toBe('');
    expect(normalizeContributionBudget('   ')).toBe('');
    expect(normalizeContributionBudget(undefined)).toBe('');
    expect(normalizeContributionBudget(null)).toBe('');
  });

  it('never yields undefined — the key must survive JSON.stringify', () => {
    const req = { budget: normalizeContributionBudget('') };
    expect(JSON.parse(JSON.stringify(req))).toEqual({ budget: '' });
  });

  it('trims and passes through a real value', () => {
    expect(normalizeContributionBudget('  $500  ')).toBe('$500');
    expect(normalizeContributionBudget('1200')).toBe('1200');
  });
});
