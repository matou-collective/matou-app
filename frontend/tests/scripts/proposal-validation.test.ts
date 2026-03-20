/**
 * Unit tests for proposal form field validation rules.
 * Tests that estimated_budget and timeline enforce positive integer values.
 */
import { describe, it, expect } from 'vitest';

// Validation rules (mirrored from CreateProposalDialog.vue)
const integerRules = [
  (val: string) => !!val || 'Required',
  (val: string) => /^\d+$/.test(val) || 'Must be a whole number',
];

function validate(rules: ((val: string) => true | string)[], value: string): string[] {
  return rules
    .map((rule) => rule(value))
    .filter((result): result is string => result !== true);
}

describe('Estimated Budget validation', () => {
  it('accepts positive integers', () => {
    expect(validate(integerRules, '100')).toEqual([]);
    expect(validate(integerRules, '0')).toEqual([]);
    expect(validate(integerRules, '999999')).toEqual([]);
  });

  it('rejects empty value', () => {
    const errors = validate(integerRules, '');
    expect(errors).toContain('Required');
  });

  it('rejects decimal numbers', () => {
    const errors = validate(integerRules, '10.5');
    expect(errors).toContain('Must be a whole number');
  });

  it('rejects negative numbers', () => {
    const errors = validate(integerRules, '-5');
    expect(errors).toContain('Must be a whole number');
  });

  it('rejects text values', () => {
    const errors = validate(integerRules, '100k');
    expect(errors).toContain('Must be a whole number');
  });

  it('rejects values with spaces', () => {
    const errors = validate(integerRules, '10 000');
    expect(errors).toContain('Must be a whole number');
  });
});

describe('Timeline (months) validation', () => {
  it('accepts positive integers', () => {
    expect(validate(integerRules, '6')).toEqual([]);
    expect(validate(integerRules, '12')).toEqual([]);
    expect(validate(integerRules, '1')).toEqual([]);
  });

  it('rejects empty value', () => {
    const errors = validate(integerRules, '');
    expect(errors).toContain('Required');
  });

  it('rejects text like "Six" or "Eight"', () => {
    expect(validate(integerRules, 'Six')).toContain('Must be a whole number');
    expect(validate(integerRules, 'Eight')).toContain('Must be a whole number');
  });

  it('rejects decimal months', () => {
    const errors = validate(integerRules, '1.5');
    expect(errors).toContain('Must be a whole number');
  });

  it('rejects values with units', () => {
    expect(validate(integerRules, '4 weeks')).toContain('Must be a whole number');
    expect(validate(integerRules, '1w')).toContain('Must be a whole number');
  });
});
