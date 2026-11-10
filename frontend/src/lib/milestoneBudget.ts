// Budget helpers for the project milestone card.
//
// Budgets are stored as free-text numerics with no currency attached, so the
// milestone card parses the raw digits out and formats the result for display.
// Mātou's projects budget in New Zealand dollars, so amounts are formatted as
// NZD rather than USD (see issue #733).

// Parse a free-form budget string ("$1,234.50", "1234", "USD 500") to a number.
// Returns 0 when nothing parseable is found.
export function parseBudget(s: string | undefined): number {
  if (!s) return 0;
  const cleaned = s.replace(/[^0-9.-]/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// Format a numeric amount as New Zealand dollars for display on the milestone
// card. Locale is left to the runtime; fractional cents are dropped to match
// the whole-dollar budgets projects are planned in.
export function formatCurrency(n: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'NZD',
    maximumFractionDigits: 0,
  }).format(n);
}
