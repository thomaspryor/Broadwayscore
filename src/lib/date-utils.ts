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
  const open = new Date(openingDate);
  const now = new Date();
  // Compare as date strings. Show "Just opened" starting on opening day
  // (the engine already gates status='open' to opening day in market-local time).
  const openDateStr = openingDate.slice(0, 10);
  const nowDateStr = now.toISOString().slice(0, 10);
  if (openDateStr > nowDateStr) return null;
  const months = (now.getFullYear() - open.getFullYear()) * 12 + (now.getMonth() - open.getMonth());
  if (months < 1) return 'Just opened';
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ${suffix}`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  if (remainingMonths === 0) return `${years} year${years === 1 ? '' : 's'} ${suffix}`;
  return `${years}+ year${years === 1 ? '' : 's'} ${suffix}`;
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

/** Get the duration suffix for a market category */
export function getDurationSuffix(category?: string): string {
  if (category === 'west-end' || category === 'off-west-end') return 'in London';
  if (category === 'off-broadway') return 'Off-Broadway';
  // Regional tryouts are emphatically NOT "on Broadway" — that's the point.
  if (category === 'regional') return 'in tryout';
  return 'on Broadway';
}
