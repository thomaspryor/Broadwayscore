/**
 * Weekly-grosses freshness rule, shared by the build-time status gate
 * (box-office-status.ts staleInputReasons) and the page banner
 * (DataStalenessBanner, kind="grosses"). Kept in its own tiny module so the
 * client banner does not pull box-office-status.ts into every page bundle.
 */

/** A week ending Sunday S is published by Tuesday S+2; this allows a missed Tuesday + Wednesday retry. */
export const MAX_GROSSES_AGE_DAYS = 10;

/** Whole calendar days from one YYYY-MM-DD date to another (the status gate's arithmetic). */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/** grosses.json stores weekEnding as M/D/YYYY. Returns YYYY-MM-DD, or null if it does not parse. */
export function mdyToIso(mdy: string | null | undefined): string | null {
  const m = mdy?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}
