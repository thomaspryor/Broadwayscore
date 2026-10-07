/**
 * Today (YYYY-MM-DD) in the viewer's own device timezone — for personal data
 * (watchlist planned dates, diary date_seen) where "today" means the user's
 * local midnight, not a show's market timezone. UTC causes off-by-one: from
 * ~8pm ET a show planned for tonight would read as already past.
 */
export function localToday(): string {
  const d = new Date();
  const offsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - offsetMs).toISOString().split('T')[0];
}

/** True only for a real YYYY-MM-DD date. The regex alone accepts 2026-02-31. */
export function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Get today's date (YYYY-MM-DD) in the market's local timezone.
 * Opening dates are calendar dates in ET (Broadway/OB) or London (WE/OWE).
 * Using UTC causes off-by-one when builds run after midnight UTC but before
 * midnight local time (e.g., 1am UTC = 9pm ET the previous day).
 */
export function getMarketDate(category?: string): string {
  const tz = (category === 'west-end' || category === 'off-west-end')
    ? 'Europe/London'
    : 'America/New_York';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/**
 * Calculate a human-readable run duration from an opening date.
 * Returns null if openingDate is falsy or the show hasn't opened yet.
 * Returns "Just opened" on opening day and for the first month.
 * @param suffix - e.g. "on Broadway" or "in the West End"
 */
export function getBroadwayDuration(openingDate: string | null, suffix = 'on Broadway'): string | null {
  if (!openingDate) return null;
  const now = new Date();
  // Compare as date strings. Show "Just opened" starting on opening day
  // (the engine already gates status='open' to opening day in market-local time).
  const openDateStr = openingDate.slice(0, 10);
  const nowDateStr = now.toISOString().slice(0, 10);
  if (openDateStr > nowDateStr) return null;
  // Whole months elapsed, both dates in UTC like the check above (the stored
  // date is a calendar date): Sept 19 to Oct 4 is not yet a month.
  const [oy, om, od] = openDateStr.split('-').map(Number);
  const months = (now.getUTCFullYear() - oy) * 12 + (now.getUTCMonth() + 1 - om)
    - (now.getUTCDate() < od ? 1 : 0);
  if (months < 1) return 'Just opened';
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ${suffix}`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  if (remainingMonths === 0) return `${years} year${years === 1 ? '' : 's'} ${suffix}`;
  return `${years}+ year${years === 1 ? '' : 's'} ${suffix}`;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Run-age label for list cards. West End pages are all London, so there is no
 * market suffix, and the label is anchored to the opening date instead of a
 * rounded duration:
 *   0 days: "Opened today" | 1: "Opened yesterday" | 2-13: "Opened 22 Sep"
 *   14 days to under a year: "Opened Sep 2026" | a year or more: "Since 2019"
 * Other markets keep getBroadwayDuration's "N months on Broadway" style.
 * @param today - YYYY-MM-DD override for the West End branch (defaults to today in London); for tests
 * @param suffix - overrides the market suffix for non-West-End markets (e.g. opera)
 */
export function getRunAgeLabel(
  openingDate: string | null | undefined,
  category?: string,
  today: string = getMarketDate(category),
  suffix?: string
): string | null {
  if (!openingDate) return null;
  if (category !== 'west-end' && category !== 'off-west-end') {
    return getBroadwayDuration(openingDate, suffix ?? getDurationSuffix(category));
  }
  const open = /^(\d{4})-(\d{2})-(\d{2})/.exec(openingDate);
  const now = /^(\d{4})-(\d{2})-(\d{2})/.exec(today);
  if (!open || !now) return null;
  const [oy, om, od] = open.slice(1).map(Number);
  const [ny, nm, nd] = now.slice(1).map(Number);
  const days = Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(oy, om - 1, od)) / 86400000);
  if (days < 0) return null;
  if (days === 0) return 'Opened today';
  if (days === 1) return 'Opened yesterday';
  if (days < 14) return `Opened ${od} ${MONTH_ABBR[om - 1]}`;
  if (days < 365) return `Opened ${MONTH_ABBR[om - 1]} ${oy}`;
  return `Since ${oy}`;
}

/**
 * Calculate run length between opening and closing dates for closed shows.
 * @param format - 'compact' returns "2+ years on Broadway", 'precise' returns "2 years, 3 months"
 * @param suffix - e.g. "on Broadway" or "in the West End" (only used in compact mode)
 */
export function getRunLength(
  openingDate: string | null | undefined,
  closingDate: string | null | undefined,
  format: 'precise' | 'compact' | 'short' = 'compact',
  suffix?: string
): string | null {
  if (!openingDate || !closingDate) return null;
  const open = new Date(openingDate);
  const close = new Date(closingDate);
  if (isNaN(open.getTime()) || isNaN(close.getTime())) return null;
  if (close <= open) return null;

  const months = (close.getFullYear() - open.getFullYear()) * 12 + (close.getMonth() - open.getMonth());
  const suffixStr = suffix ? ` ${suffix}` : '';

  if (months < 1) return format === 'short' ? '<1mo' : `less than a month${suffixStr}`;

  if (format === 'short') {
    // Abbreviated: "2mos", "1yr", "3yrs"
    if (months < 12) return `${months}mo${months === 1 ? '' : 's'}`;
    const years = Math.floor(months / 12);
    const remaining = months % 12;
    if (remaining === 0) return `${years}yr${years === 1 ? '' : 's'}`;
    return `${years}+yr${years === 1 ? '' : 's'}`;
  }

  if (format === 'compact') {
    if (months < 12) return `${months} month${months === 1 ? '' : 's'}${suffixStr}`;
    const years = Math.floor(months / 12);
    const remaining = months % 12;
    if (remaining === 0) return `${years} year${years === 1 ? '' : 's'}${suffixStr}`;
    return `${years}+ year${years === 1 ? '' : 's'}${suffixStr}`;
  }

  // Precise format: "2 years, 3 months"
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  const remaining = months % 12;
  if (remaining === 0) return `${years} year${years === 1 ? '' : 's'}`;
  return `${years} year${years === 1 ? '' : 's'}, ${remaining} month${remaining === 1 ? '' : 's'}`;
}

/**
 * Extract the calendar year from a bare "YYYY-MM-DD" show date field. Reads
 * the year straight from the string rather than through `new Date(...).
 * getFullYear()` — that reads the LOCAL year, so a Jan-1 date (13 shows in
 * shows.json have one, e.g. "A Christmas Carol" closingDate 2023-01-01)
 * parses as UTC midnight and would read back as the prior year on any
 * negative-UTC-offset machine — the same bug class as BRO-3047, just for a
 * year instead of a full date.
 */
export function getShowYear(dateStr: string | null | undefined): number | null {
  if (!dateStr || dateStr.length < 4) return null;
  const year = Number.parseInt(dateStr.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

/** Format a date string as "Mon YYYY" (e.g. "Jan 2025") */
export function formatOpeningDate(dateStr: string | null | undefined): string {
  // Returns '' rather than a formatted epoch for missing/invalid input.
  // `new Date(null)` is 1970-01-01, so the old unguarded version rendered
  // "Opens Jan 1970" for every show whose openingDate isn't set yet — six of
  // them were live on the Tony season page (owner, 2026-08-13). Guarding the
  // formatter rather than each call site means no future caller can reprint it.
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * Format a bare "YYYY-MM-DD" show date field (openingDate, closingDate,
 * previewsStartDate) for display, e.g. "Jul 26, 2026". `new Date(str)` parses
 * as UTC midnight; without a UTC override, .toLocaleDateString() shifts the
 * result to the viewer's local timezone, rendering one day early for every
 * US timezone (BRO-3047). This always formats in UTC so the calendar date
 * shown matches the stored value regardless of the viewer's timezone.
 *
 * Only the first 10 characters (the YYYY-MM-DD date part) are parsed, and
 * always as UTC midnight — a field that unexpectedly carries a full
 * timestamp-with-offset (e.g. "2026-07-26T23:00:00-04:00") would otherwise
 * shift the calendar date depending on the embedded offset, reintroducing
 * the same class of bug this helper exists to prevent. `options.timeZone`
 * is always forced to UTC, even if a caller passes one — this helper's
 * entire contract is "render the stored calendar date," which only holds
 * under UTC.
 */
export function formatShowDate(
  dateStr: string | null | undefined,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
): string {
  if (!dateStr) return '';
  const date = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
}

/** Get the duration suffix for a market category */
export function getDurationSuffix(category?: string): string {
  if (category === 'west-end' || category === 'off-west-end') return 'in London';
  if (category === 'off-broadway') return 'Off-Broadway';
  // Regional tryouts are emphatically NOT "on Broadway" — that's the point.
  if (category === 'regional') return 'in tryout';
  if (category === 'tour') return 'on tour';
  return 'on Broadway';
}
