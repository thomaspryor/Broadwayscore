/**
 * Tony-season windows derived from public/data/stats-canon.json.
 *
 * Definition (spec §"Season scoping"): a season runs from the DAY AFTER one
 * ceremony through the DAY OF the next, inclusive. A show seen ON ceremony day
 * therefore belongs to the season that ceremony closes, not the one it opens.
 *
 * All dates are plain "YYYY-MM-DD" strings compared lexicographically. There is
 * deliberately no Date arithmetic: `date_seen` has no timezone and Date() would
 * shift it across a day boundary for anyone west of UTC.
 *
 * NOTE ON LABELS: labels are derived from the ceremony sequence, not read from
 * the winner rows in stats-canon.json. The winner rows' `ceremony` numbers are
 * off by one for ceremonies ≥75 (A Strange Loop, the 75th Tonys, is tagged 76)
 * — an upstream generator bug from the missing COVID season. Their `season`
 * strings are correct, so `windowForSeason()` joins on the season label and
 * canonProgress() uses that rather than the ceremony number.
 */

import type { CanonCeremony, StatsCanon } from './types';

export interface SeasonWindow {
  /** Ceremony number that closes this season; null for the open, current one. */
  ceremony: number | null;
  /** "2021-22" */
  label: string;
  /** Inclusive start ("YYYY-MM-DD"), or null for the open-ended first season. */
  start: string | null;
  /** Inclusive end ("YYYY-MM-DD") — the ceremony date, or a provisional June 30. */
  end: string;
  /** True when `end` is a placeholder because the next ceremony is unannounced. */
  provisional: boolean;
}

/** Add one day to a plain "YYYY-MM-DD" without touching local time. */
export function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map((v) => parseInt(v, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * Provisional end for the still-running season: June 30 following its start.
 *
 * Modern ceremonies land in June, so a season starting in June/later ends the
 * following June 30; a season starting January–May ends the same June 30.
 */
export function provisionalSeasonEnd(startISO: string): string {
  const year = parseInt(startISO.slice(0, 4), 10);
  const month = parseInt(startISO.slice(5, 7), 10);
  return `${month >= 6 ? year + 1 : year}-06-30`;
}

/**
 * Season label for a ceremony, given the year of the previous ceremony.
 *
 * Normally the season is (Y-1)–Y. When a year was skipped — 2020, when no
 * ceremony was held and the 74th (September 2021) honored 2019-20 — the label
 * follows the previous ceremony, so the gap season is named for the work it
 * covers rather than the year it was finally awarded in.
 */
export function seasonLabel(ceremonyYear: number, prevCeremonyYear: number | null): string {
  const startYear =
    prevCeremonyYear !== null && prevCeremonyYear < ceremonyYear
      ? prevCeremonyYear
      : ceremonyYear - 1;
  const endYear = startYear + 1;
  return `${startYear}-${String(endYear).slice(-2)}`;
}

/**
 * Build the full list of season windows, oldest first.
 *
 * The first window is open-ended (`start: null`) so pre-1947 diary entries
 * still bucket somewhere. The last window is the in-progress season: it exists
 * whenever the most recent ceremony has already happened, and carries
 * `provisional: true` with a June 30 placeholder end.
 *
 * @param canon parsed public/data/stats-canon.json (only `ceremonies` is read)
 * @param opts.today "YYYY-MM-DD"; controls whether the open season is emitted
 */
export function seasonWindows(
  canon: Pick<StatsCanon, 'ceremonies'>,
  opts: { today?: string } = {}
): SeasonWindow[] {
  const ceremonies: CanonCeremony[] = [...(canon?.ceremonies ?? [])]
    .filter((c) => c && typeof c.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const windows: SeasonWindow[] = [];
  let prevYear: number | null = null;

  for (let i = 0; i < ceremonies.length; i++) {
    const c = ceremonies[i];
    const year = parseInt(c.date.slice(0, 4), 10);
    windows.push({
      ceremony: c.ceremony,
      label: seasonLabel(year, prevYear),
      start: i === 0 ? null : nextDay(ceremonies[i - 1].date),
      end: c.date,
      provisional: false,
    });
    prevYear = year;
  }

  const last = ceremonies[ceremonies.length - 1];
  if (last) {
    const start = nextDay(last.date);
    const today = opts.today;
    // Only emit the open season once it has actually begun. Without a `today`
    // we assume it has — the canon always trails reality by at most a year.
    if (!today || today >= start) {
      const lastYear = parseInt(last.date.slice(0, 4), 10);
      windows.push({
        ceremony: null,
        label: seasonLabel(lastYear + 1, lastYear),
        start,
        end: provisionalSeasonEnd(start),
        provisional: true,
      });
    }
  }

  return windows;
}

/**
 * The window a plain date falls in, or null. Ceremony day resolves to the
 * season that ceremony closes (windows are end-inclusive).
 */
export function seasonForDate(
  windows: SeasonWindow[],
  dateSeen: string | null | undefined
): SeasonWindow | null {
  if (!dateSeen) return null;
  for (const w of windows) {
    if (w.start !== null && dateSeen < w.start) continue;
    if (dateSeen <= w.end) return w;
  }
  return null;
}

/** Look a window up by its season label ("2021-22"). */
export function windowForSeason(
  windows: SeasonWindow[],
  season: string | null | undefined
): SeasonWindow | null {
  if (!season) return null;
  return windows.find((w) => w.label === season) ?? null;
}
