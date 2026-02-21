/**
 * Calculate a human-readable run duration from an opening date.
 * Returns null if openingDate is falsy.
 * @param suffix - e.g. "on Broadway" or "in the West End"
 */
export function getBroadwayDuration(openingDate: string | null, suffix = 'on Broadway'): string | null {
  if (!openingDate) return null;
  const open = new Date(openingDate);
  const now = new Date();
  const months = (now.getFullYear() - open.getFullYear()) * 12 + (now.getMonth() - open.getMonth());
  if (months < 1) return 'Just opened';
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ${suffix}`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  if (remainingMonths === 0) return `${years} year${years === 1 ? '' : 's'} ${suffix}`;
  return `${years}+ year${years === 1 ? '' : 's'} ${suffix}`;
}
