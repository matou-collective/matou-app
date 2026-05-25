// Week boundaries follow Mon-start (NZ/most-of-world). All functions
// operate on local time so they line up with what the user sees in their
// browser's locale formatting.

/** Returns a new Date at the Monday 00:00:00.000 of the input's week. */
export function startOfWeek(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  // getDay(): 0=Sun, 1=Mon, ..., 6=Sat. Mon-start means shift by (getDay+6)%7.
  const dayOffset = (r.getDay() + 6) % 7;
  r.setDate(r.getDate() - dayOffset);
  return r;
}

/** Returns a new Date at the Sunday 23:59:59.999 of the input's week. */
export function endOfWeek(d: Date): Date {
  const start = startOfWeek(d);
  const r = new Date(start);
  r.setDate(r.getDate() + 6);
  r.setHours(23, 59, 59, 999);
  return r;
}

/** Returns a new Date n weeks after d (n may be negative). Does not mutate d. */
export function addWeeks(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n * 7);
  return r;
}

/** True iff both dates fall in the same Mon-Sun week. */
export function sameWeek(a: Date, b: Date): boolean {
  return startOfWeek(a).getTime() === startOfWeek(b).getTime();
}

/** Stable string key for the week that contains d. Format: YYYY-MM-DD of the Monday. */
export function weekKey(d: Date): string {
  const s = startOfWeek(d);
  const yyyy = s.getFullYear();
  const mm = String(s.getMonth() + 1).padStart(2, '0');
  const dd = String(s.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
