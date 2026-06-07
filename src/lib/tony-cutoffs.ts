/**
 * Canonical Tony Awards eligibility windows by ceremony year.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for Tony season date ranges in this
 * codebase. Used by:
 *   - src/lib/tony-seasons.ts          (Time Period filter on show lists)
 *   - src/lib/data-tony-predictions.ts (Tony predictions pages, /tony-awards/*)
 *
 * Each season's `end` is the official Tony Awards Administration Committee
 * eligibility cutoff for that ceremony — the LAST DAY a show can open and be
 * counted. The next season's `start` is the day after. Dates are inclusive
 * on both ends. ISO 8601 (YYYY-MM-DD) so lexicographic compare = chronological.
 *
 * Why this matters: shows often open on the cutoff day to maximize their
 * Tony eligibility window for that ceremony. Lost Boys 2026 opened on
 * 2026-04-26 — the EXACT cutoff for the 79th ceremony. A 1-day error in
 * either direction misclassifies high-profile openings.
 *
 * Update annually when the Tony Awards Administration Committee announces
 * the next season's calendar (typically released in summer/fall).
 *
 * COVID era: the 74th (2020) was truncated at Feb 19, 2020. There was no
 * separate 2020-21 ceremony — the 75th (2022) covered Feb 20, 2020 → May 4,
 * 2022 in one combined window. We split that window into "2020-21" and
 * "2021-22" labels for filter UX (project convention; no official source).
 */

export interface TonySeasonRecord {
  /** Ceremony year — e.g. 2026 for the 79th Tony Awards held June 2026 */
  ceremonyYear: number;
  /** Display label, e.g. "2025-26" */
  label: string;
  /** Window start (inclusive), ISO YYYY-MM-DD */
  start: string;
  /** Window end (inclusive), ISO YYYY-MM-DD — the official eligibility cutoff */
  end: string;
  /** Date the ceremony was/will be held, ISO YYYY-MM-DD. Optional — only
   *  populated for seasons we have confirmed (or scheduled) dates for. Used
   *  for the "X days to Tony ceremony" countdown on the Awards Scorecard. */
  ceremonyDate?: string;
  /** Optional explanation when the window deviates from the standard April→April pattern */
  notes?: string;
  /** Citation for verifiability — URL or short description */
  source: string;
}

export const TONY_CUTOFFS: TonySeasonRecord[] = [
  {
    ceremonyYear: 2014,
    label: '2013-14',
    start: '2013-04-26',
    end: '2014-04-24',
    source: 'en.wikipedia.org/wiki/68th_Tony_Awards',
  },
  {
    ceremonyYear: 2015,
    label: '2014-15',
    start: '2014-04-25',
    end: '2015-04-23',
    source: 'en.wikipedia.org/wiki/69th_Tony_Awards',
  },
  {
    ceremonyYear: 2016,
    label: '2015-16',
    start: '2015-04-24',
    end: '2016-04-28',
    source: 'en.wikipedia.org/wiki/70th_Tony_Awards',
  },
  {
    ceremonyYear: 2017,
    label: '2016-17',
    start: '2016-04-29',
    end: '2017-04-27',
    source: 'tonyawards.com — 71st announcement (start "Apr 29, 2016—immediately following the eligibility cutoff for the prior season")',
  },
  {
    ceremonyYear: 2018,
    label: '2017-18',
    start: '2017-04-28',
    end: '2018-04-26',
    source: 'tonyawards.com — 72nd eligibility part 4',
  },
  {
    ceremonyYear: 2019,
    label: '2018-19',
    start: '2018-04-27',
    end: '2019-04-25',
    source: 'tonyawards.com — 2019 rules & regulations PDF',
  },
  {
    ceremonyYear: 2020,
    label: '2019-20',
    start: '2019-04-26',
    end: '2020-02-19',
    notes: 'COVID truncation — Broadway shut down 2020-03-12; only 18 shows that opened by Feb 19 were eligible. Original cutoff would have been ~Apr 23, 2020.',
    source: 'en.wikipedia.org/wiki/74th_Tony_Awards; broadwaynews.com/2020/08/21/tony-awards-to-announce-february-eligibility-cutoff-date',
  },
  {
    ceremonyYear: 2021,
    label: '2020-21',
    start: '2020-02-20',
    end: '2021-04-25',
    notes: 'No separate ceremony for 2020-21 — combined into the 75th (held 2022). This sub-window is a project convention covering the calendar 2020-21 portion of the combined COVID eligibility period.',
    source: 'project convention; underlying combined-eligibility per en.wikipedia.org/wiki/75th_Tony_Awards (Feb 20, 2020 → May 4, 2022)',
  },
  {
    ceremonyYear: 2022,
    label: '2021-22',
    start: '2021-04-26',
    end: '2022-05-04',
    notes: 'COVID-extended cutoff (originally Apr 28, 2022 — extended one week to accommodate delayed openings). 75th ceremony covered the combined Feb 20, 2020 → May 4, 2022 window.',
    source: 'en.wikipedia.org/wiki/75th_Tony_Awards; variety.com/2022/legit/news/tony-awards-2022-date-extension-1235239180',
  },
  {
    ceremonyYear: 2023,
    label: '2022-23',
    start: '2022-05-05',
    end: '2023-04-27',
    source: 'en.wikipedia.org/wiki/76th_Tony_Awards',
  },
  {
    ceremonyYear: 2024,
    label: '2023-24',
    start: '2023-04-28',
    end: '2024-04-25',
    source: 'en.wikipedia.org/wiki/77th_Tony_Awards; tonyawards.com — 2024 eligibility part 4',
  },
  {
    ceremonyYear: 2025,
    label: '2024-25',
    start: '2024-04-26',
    end: '2025-04-27',
    ceremonyDate: '2025-06-08',
    source: 'tonyawards.com — 78th announcement; en.wikipedia.org/wiki/78th_Tony_Awards',
  },
  {
    ceremonyYear: 2026,
    label: '2025-26',
    start: '2025-04-28',
    end: '2026-04-26',
    ceremonyDate: '2026-06-07',
    source: 'tonyawards.com/press/the-tony-awards-announces-calendar-of-events-for-2025-2026-season; broadwaydirect.com/shows-eligible-for-the-2026-tony-awards',
  },
  {
    ceremonyYear: 2027,
    label: '2026-27',
    start: '2026-04-27',
    end: '2027-04-25',
    notes: 'PROVISIONAL — Tony Awards Administration Committee has not yet announced the 80th cutoff. Start is the day after the 79th cutoff. End is a placeholder using the recent ~Apr 25 trend; update when announced (typically released summer/fall of the season-start year).',
    source: 'projected — pending official 80th announcement',
  },
];

/** Map for O(1) lookup by ceremony year. Frozen — mutate via TONY_CUTOFFS only. */
const BY_CEREMONY_YEAR = new Map<number, TonySeasonRecord>(
  TONY_CUTOFFS.map((s) => [s.ceremonyYear, s]),
);

const BY_LABEL = new Map<string, TonySeasonRecord>(
  TONY_CUTOFFS.map((s) => [s.label, s]),
);

/** Returns the record for a ceremony year, or null if outside the table. */
export function tonySeasonForCeremonyYear(ceremonyYear: number): TonySeasonRecord | null {
  return BY_CEREMONY_YEAR.get(ceremonyYear) ?? null;
}

/** Returns the record for a season label like "2025-26", or null. */
export function tonySeasonForLabel(label: string): TonySeasonRecord | null {
  return BY_LABEL.get(label) ?? null;
}

/**
 * Returns the Tony season the given ISO date falls into, or null if before
 * the earliest tracked season or after the latest. Inclusive on both ends.
 */
export function tonySeasonForDate(isoDate: string): TonySeasonRecord | null {
  for (const s of TONY_CUTOFFS) {
    if (isoDate >= s.start && isoDate <= s.end) return s;
  }
  return null;
}

/**
 * Returns the "current" Tony season — the one whose window contains today.
 * If today is in a gap between seasons (rare; should not happen with our
 * contiguous data), returns the most recent past season.
 */
export function currentTonySeason(today: Date = new Date()): TonySeasonRecord {
  const iso = today.toISOString().slice(0, 10);
  const match = tonySeasonForDate(iso);
  if (match) return match;
  // Today is past the last cutoff — return the latest record
  return TONY_CUTOFFS[TONY_CUTOFFS.length - 1];
}

/**
 * Returns the Tony season that should be featured on predictions pages.
 *
 * Differs from currentTonySeason() in the April→June gap between the eligibility
 * cutoff and the ceremony: during that gap, currentTonySeason() has already
 * advanced to the new season (no shows yet), but predictions should still show
 * the outgoing season's nominees. E.g. from April 27 to June 6, 2026,
 * currentTonySeason() returns 2026-27 (empty) while this returns 2025-26
 * (16 nominees ready, ceremony June 7).
 *
 * Logic: if the previous season has a known ceremony date that's still in the
 * future, return it — otherwise return the actual current season.
 */
export function currentPredictionSeason(today: Date = new Date()): TonySeasonRecord {
  const iso = today.toISOString().slice(0, 10);
  const actual = tonySeasonForDate(iso) ?? TONY_CUTOFFS[TONY_CUTOFFS.length - 1];
  const actualIndex = TONY_CUTOFFS.findIndex(r => r.label === actual.label);
  if (actualIndex > 0) {
    const prev = TONY_CUTOFFS[actualIndex - 1];
    if (prev.ceremonyDate) {
      // Show the outgoing season through ceremony day + 14-day grace period
      const d = new Date(prev.ceremonyDate);
      d.setDate(d.getDate() + 14);
      const gracePeriodEnd = d.toISOString().slice(0, 10);
      if (gracePeriodEnd >= iso) return prev;
    }
  }
  return actual;
}

/** All seasons, newest first. */
export function allTonySeasonsNewestFirst(): TonySeasonRecord[] {
  return [...TONY_CUTOFFS].reverse();
}

/** Earliest tracked ceremony year. */
export const FIRST_TRACKED_CEREMONY_YEAR = TONY_CUTOFFS[0].ceremonyYear;

/** Latest tracked ceremony year. */
export const LATEST_TRACKED_CEREMONY_YEAR = TONY_CUTOFFS[TONY_CUTOFFS.length - 1].ceremonyYear;

/**
 * Days until the Tony ceremony for a given season label. Returns null when:
 *   - The season isn't in our records
 *   - The season has no scheduled ceremonyDate
 *   - The ceremony has already passed
 * Used by the Awards Scorecard's "X days to Tony ceremony" pill.
 */
export function daysUntilTonyCeremony(season: string, today: Date = new Date()): number | null {
  const record = BY_LABEL.get(season);
  if (!record?.ceremonyDate) return null;
  const ceremonyMs = new Date(`${record.ceremonyDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(ceremonyMs)) return null;
  const diff = ceremonyMs - today.getTime();
  if (diff <= 0) return null;
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

/**
 * True if the ceremony for the given season is in the future. Used to compute
 * `inProgress` on award scoring — a show is in-progress if its ceremony
 * hasn't happened yet, not if the current eligibility window contains today
 * (those differ for shows in the April-cutoff-to-June-ceremony gap).
 *
 * Resolution order:
 *  1. Unknown season → false (conservative; don't pulse shows with bad data)
 *  2. Explicit `ceremonyDate` → compare directly
 *  3. No ceremonyDate → fall back to record.end + 90-day gap. The Tony
 *     ceremony historically lands ~5-7 weeks after the eligibility cutoff;
 *     90 days is a comfortable upper bound. So a 2023-24 season ending
 *     2024-04-25 is treated as concluded after 2024-07-24. This avoids
 *     marking 733 historical Tony shows as "in progress" forever (the bug
 *     that prompted this rewrite — ship-check 2026-05-17).
 */
export function tonyCeremonyIsFuture(season: string | undefined, today: Date = new Date()): boolean {
  if (!season) return false;
  const record = BY_LABEL.get(season);
  if (!record) return false;
  if (record.ceremonyDate) {
    const ceremonyMs = new Date(`${record.ceremonyDate}T00:00:00Z`).getTime();
    if (!Number.isFinite(ceremonyMs)) return false;
    return ceremonyMs > today.getTime();
  }
  // No explicit ceremonyDate — derive from eligibility cutoff + 90-day window.
  const endMs = new Date(`${record.end}T00:00:00Z`).getTime();
  if (!Number.isFinite(endMs)) return false;
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  return (endMs + NINETY_DAYS_MS) > today.getTime();
}
