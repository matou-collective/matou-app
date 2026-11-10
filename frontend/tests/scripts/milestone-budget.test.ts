import { describe, it, expect } from 'vitest';
import { parseBudget, formatCurrency } from '../../src/lib/milestoneBudget';

describe('formatCurrency', () => {
  it('formats amounts as New Zealand dollars (NZD), not USD (#733)', () => {
    const formatted = formatCurrency(7845);
    // NZD, not USD: the NZD currency code must be reflected in the output.
    const parts = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'NZD',
      maximumFractionDigits: 0,
    }).formatToParts(7845);
    expect(formatted).toBe(parts.map((p) => p.value).join(''));
    // The ISO code resolves to NZD, not USD, when the formatter is asked to
    // display the currency code explicitly.
    const withCode = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'NZD',
      currencyDisplay: 'code',
    }).format(7845);
    expect(withCode).toContain('NZD');
    expect(withCode).not.toContain('USD');
    // And the symbol form disambiguates from a plain US dollar amount.
    const nzdSymbol = formatCurrency(7845);
    const usdSymbol = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(7845);
    expect(nzdSymbol).not.toBe(usdSymbol);
  });

  it('drops fractional cents (whole-dollar budgets)', () => {
    expect(formatCurrency(100.75)).toBe(
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'NZD',
        maximumFractionDigits: 0,
      }).format(100.75),
    );
  });
});

describe('parseBudget', () => {
  it('strips currency symbols and separators to a number', () => {
    expect(parseBudget('$1,234.50')).toBe(1234.5);
    expect(parseBudget('1234')).toBe(1234);
    expect(parseBudget('USD 500')).toBe(500);
  });

  it('returns 0 for empty or unparseable input', () => {
    expect(parseBudget(undefined)).toBe(0);
    expect(parseBudget('')).toBe(0);
    expect(parseBudget('n/a')).toBe(0);
  });
});
