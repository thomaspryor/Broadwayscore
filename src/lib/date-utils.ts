/**
 * Calculate a human-readable run duration from an opening date.
 * Returns null if openingDate is falsy.
 * @param suffix - e.g. "on Broadway" or "in the West End"
 */
export function getBroadwayDuration(openingDate: string | null, suffix = 'on Broadway'): string | null {
  if (!openingDate) return null;
  const open = new Date(openingDate);
  const now = new Date();
  if (open > now) return null;
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
export function formatOpeningDate(dateStr: string): string {
  const date = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Get the duration suffix for a market category */
export function getDurationSuffix(category?: string): string {
  if (category === 'west-end' || category === 'off-west-end') return 'in London';
  if (category === 'off-broadway') return 'Off-Broadway';
  return 'on Broadway';
}
