// Shared currency formatting for the /biz Investment Tracker.
// Single source of truth so a missing data point renders "—" everywhere
// instead of drifting per-component (the null → "~$0" credibility bug).
//
// Re-exports the app-wide formatCurrency from @/lib/formatting rather than
// reimplementing it — the /biz components previously each had their own
// ad-hoc copy; this file was almost a third fork of the same K/M/B logic.

import { formatCurrency } from './formatting';
import type { CapitalSummary } from './commercial-metrics';
export { formatCurrency };

/**
 * One show's capitalization. A figure that names the outlet or filing that
 * reported it prints plain ("$24.0M"); one flagged isEstimate.capitalization
 * or with no publishable source gets the "~" estimate mark
 * (isEstimatedCapitalization in commercial-display.ts). BRO-4623: an unconditional "~" made reported
 * figures read as our guesses. The flag is a required argument so a caller
 * cannot fall back to marking everything. A missing value renders bare "—",
 * never "~—". Modeled figures (break-even, % recouped) and capital totals
 * (formatCapitalSummary) keep their "~".
 */
export function formatCapitalization(amount: number | null | undefined, isEstimate: boolean): string {
  if (amount === null || amount === undefined) return '—';
  return isEstimate ? `~${formatCurrency(amount)}` : formatCurrency(amount);
}

export interface CapitalSummaryDisplay {
  /** "~$42.0M", "~$42.0M+", "Undisclosed" or "None". */
  value: string;
  /** "3 of 9 undisclosed" when some figures are missing, else null. */
  note: string | null;
}

/**
 * A capital total that never prints an unknown as $0 (BRO-4623 P0-6: a season
 * with running shows read "~$0 Capital at Risk" because only shows with a
 * known capitalization and a TBD designation were summed).
 *  - no shows counted → "None"
 *  - shows counted but no figure known → "Undisclosed"
 *  - some figures missing → "~$X+" with "N of M undisclosed"
 */
export function formatCapitalSummary(summary: CapitalSummary): CapitalSummaryDisplay {
  const { knownTotal, showCount, undisclosedCount } = summary;
  if (showCount === 0) return { value: 'None', note: null };
  if (knownTotal <= 0) {
    return {
      value: 'Undisclosed',
      note: `${showCount} show${showCount === 1 ? '' : 's'}, capitalization not public`,
    };
  }
  const partial = undisclosedCount > 0;
  return {
    value: `~${formatCurrency(knownTotal)}${partial ? '+' : ''}`,
    note: partial ? `${undisclosedCount} of ${showCount} undisclosed` : null,
  };
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "9/13/2026" (grosses week ending), "2026-09-26" or an ISO timestamp
 * ("2026-10-03T12:00:00Z") → "Sep 13, 2026". Parsed by hand so the server's
 * time zone can never shift the day. Unparseable → null.
 */
export function formatDataDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const s = date.trim();
  let year: number;
  let month: number;
  let day: number;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (us) {
    month = parseInt(us[1], 10);
    day = parseInt(us[2], 10);
    year = parseInt(us[3], 10);
  } else if (iso) {
    year = parseInt(iso[1], 10);
    month = parseInt(iso[2], 10);
    day = parseInt(iso[3], 10);
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${MONTH_ABBR[month - 1]} ${day}, ${year}`;
}

/**
 * Date column of the /biz Recent Developments list: YYYY-MM (recoupments) and
 * YYYY-MM-DD (closings) both read "Sep 2026", so every row carries its year
 * ("Sep 20" next to "May 2026" read as September 2020). A bare year or
 * anything unparseable passes through unchanged.
 */
export function formatDevelopmentDate(date: string): string {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(date.trim());
  if (!m) return date;
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return date;
  return `${MONTH_ABBR[month - 1]} ${m[1]}`;
}

/**
 * Newest first, for the dated rows of the /biz Recent Developments list.
 * Recoupment dates are YYYY-MM or a bare year, closing dates YYYY-MM-DD; ISO
 * prefixes compare correctly as strings, so "2026-09-14" sorts above
 * "2026-06". The sort is stable, so equal dates keep their input order.
 * BRO-4623: the list used to print recoupments above closings, so a
 * September closing sat under May recoupments.
 */
export function sortNewestFirst<T>(items: readonly T[], isoDateOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const da = isoDateOf(a);
    const db = isoDateOf(b);
    return da < db ? 1 : da > db ? -1 : 0;
  });
}
