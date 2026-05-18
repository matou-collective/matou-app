// Small wrappers around toLocaleDateString / toLocaleString using the
// browser's default locale. Centralised so future locale changes are a
// one-file edit, but no format is forced.

type DateInput = Date | string | number | null | undefined;

function toDate(input: DateInput): Date | null {
  if (input == null || input === '') return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Short date in the user's locale (e.g. en-US: "5/18/2026", en-GB: "18/05/2026"). */
export function formatDate(input: DateInput): string {
  const d = toDate(input);
  return d ? d.toLocaleDateString() : '';
}

/** Date + time in the user's locale. */
export function formatDateTime(input: DateInput): string {
  const d = toDate(input);
  return d ? d.toLocaleString() : '';
}

/** "just now" / "5m ago" / "2h ago" / "3d ago" / locale date after 30 days. */
export function formatRelative(input: DateInput): string {
  const d = toDate(input);
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(d);
}
