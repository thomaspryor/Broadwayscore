/**
 * Calculate a human-readable Broadway run duration from an opening date.
 * Returns null if openingDate is falsy.
 */
export function getBroadwayDuration(openingDate: string | null): string | null {
  if (!openingDate) return null;
  const open = new Date(openingDate);
  const now = new Date();
  const months = (now.getFullYear() - open.getFullYear()) * 12 + (now.getMonth() - open.getMonth());
  if (months < 1) return 'Just opened';
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} on Broadway`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  if (remainingMonths === 0) return `${years} year${years === 1 ? '' : 's'} on Broadway`;
  return `${years}+ year${years === 1 ? '' : 's'} on Broadway`;
}
