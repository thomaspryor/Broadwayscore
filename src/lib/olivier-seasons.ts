/**
 * Olivier season definitions and date-range helpers.
 *
 * Per-year cutoffs come from src/lib/olivier-cutoffs.ts (single source of
 * truth, cited from SOLT / Wikipedia). Consumer code should import from this
 * module rather than reaching into cutoffs directly.
 *
 * Used by:
 *   - src/lib/data-show-ranks.ts (West End / Off-West End "this season" pool)
 *   - future Time Period filter on West End show lists (parity with tony-seasons.ts)
 */
import {
  OLIVIER_CUTOFFS,
  currentOlivierSeason,
  olivierSeasonForDate,
  type OlivierSeasonRecord,
} from '@/lib/olivier-cutoffs';
import type { DateRange, RangeDef } from '@/lib/tony-seasons';

/**
 * 8 most recent Olivier seasons, newest first.
 * Mirrors TONY_SEASONS shape for cross-market UX consistency.
 */
export const OLIVIER_SEASONS: RangeDef[] = OLIVIER_CUTOFFS
  .slice()
  .reverse()
  .slice(0, 8)
  .map((s) => ({
    id: s.label,
    label: s.label.replace('-', '–'),
    from: s.start,
    to: s.end,
  }));

/**
 * Returns the current Olivier season as a DateRange (start/end inclusive),
 * or null if the cutoffs table is empty.
 *
 * "Current" = the window today's date falls into. If today is past the last
 * known cutoff (e.g. SOLT hasn't announced the next window yet), returns the
 * latest record's range.
 */
export function getOlivierSeasonWindow(today: Date = new Date()): DateRange | null {
  const record = currentOlivierSeason(today);
  if (!record) return null;
  return { from: record.start, to: record.end };
}

/** Returns the current Olivier season record (full metadata), or null. */
export function getCurrentOlivierSeasonRecord(today: Date = new Date()): OlivierSeasonRecord | null {
  return currentOlivierSeason(today);
}

/**
 * Returns true if a show with the given openingDate (ISO YYYY-MM-DD) opened
 * within the current Olivier season window. Used by the show-rank pool filter
 * for West End and Off-West End markets.
 */
export function isInCurrentOlivierSeason(openingDate: string | null | undefined, today: Date = new Date()): boolean {
  if (!openingDate) return false;
  const window = getOlivierSeasonWindow(today);
  if (!window) return false;
  return openingDate >= window.from && openingDate <= window.to;
}

/**
 * Returns the Olivier season the given show opened in (by openingDate), or
 * null if before the earliest tracked season / no openingDate.
 */
export function olivierSeasonForShow(openingDate: string | null | undefined): OlivierSeasonRecord | null {
  if (!openingDate) return null;
  return olivierSeasonForDate(openingDate);
}
