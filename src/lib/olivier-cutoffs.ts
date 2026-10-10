/**
 * Canonical Olivier Awards eligibility windows by ceremony year.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for Olivier season date ranges in this
 * codebase. Used by:
 *   - src/lib/olivier-seasons.ts (filter / UX layer)
 *   - src/lib/data-show-ranks.ts (West End / Off-West End season rank pool)
 *
 * Each season's `end` is the SOLT (Society of London Theatre) eligibility
 * cutoff for that ceremony — the LAST DAY a West End show can open and be
 * counted. The next season's `start` is the day after. Dates are inclusive
 * on both ends. ISO 8601 (YYYY-MM-DD) so lexicographic compare = chronological.
 *
 * Why this matters: London shows often open near the cutoff to maximise the
 * Olivier eligibility window. A 1-day error misclassifies high-profile
 * openings. SOLT has historically shifted the window for COVID (2020-21) and
 * occasional calendar-reset years — re-verify annually.
 *
 * `lastVerified`: ISO date the entry was last cross-checked against an
 * authoritative SOLT/Wikipedia source. The check-cutoff-freshness CI gate
 * warns when the current ceremony's `end` is within 60 days AND `lastVerified`
 * is more than 60 days old.
 *
 * Update annually when SOLT announces the next season's calendar (typically
 * autumn of the season-start year).
 */

export interface OlivierSeasonRecord {
  /** Ceremony year — e.g. 2026 for the 50th Olivier Awards held April 2026 */
  ceremonyYear: number;
  /** Display label, e.g. "2024-25" */
  label: string;
  /** Window start (inclusive), ISO YYYY-MM-DD */
  start: string;
  /** Window end (inclusive), ISO YYYY-MM-DD — SOLT eligibility cutoff */
  end: string;
  /** ISO date this entry was last cross-checked against SOLT/source. */
  lastVerified: string;
  /** Optional explanation when the window deviates from the standard ~Feb→Feb pattern */
  notes?: string;
  /** Citation for verifiability — URL or short description */
  source: string;
}

export const OLIVIER_CUTOFFS: OlivierSeasonRecord[] = [
  {
    ceremonyYear: 2016,
    label: '2015-16',
    start: '2015-02-26',
    end: '2016-02-16',
    lastVerified: '2026-05-16',
    source: 'en.wikipedia.org/wiki/2016_Laurence_Olivier_Awards',
  },
  {
    ceremonyYear: 2017,
    label: '2016-17',
    start: '2016-02-17',
    end: '2017-02-21',
    lastVerified: '2026-05-16',
    source: 'en.wikipedia.org/wiki/2017_Laurence_Olivier_Awards',
  },
  {
    ceremonyYear: 2018,
    label: '2017-18',
    start: '2017-02-22',
    end: '2018-02-21',
    lastVerified: '2026-05-16',
    source: 'en.wikipedia.org/wiki/2018_Laurence_Olivier_Awards',
  },
  {
    ceremonyYear: 2019,
    label: '2018-19',
    start: '2018-02-22',
    end: '2019-02-19',
    lastVerified: '2026-05-16',
    source: 'en.wikipedia.org/wiki/2019_Laurence_Olivier_Awards',
  },
  {
    ceremonyYear: 2020,
    label: '2019-20',
    start: '2019-02-20',
    end: '2020-02-18',
    lastVerified: '2026-05-16',
    source: 'en.wikipedia.org/wiki/2020_Laurence_Olivier_Awards; officiallondontheatre.com — eligibility cut-off Tue 18 Feb',
  },
  {
    ceremonyYear: 2022,
    label: '2020-22',
    start: '2020-02-19',
    end: '2022-02-22',
    lastVerified: '2026-05-16',
    notes: 'COVID combined window — the 2021 ceremony was cancelled due to UK theatre closures (Mar 2020 – mid-2021). SOLT expanded the 2022 eligibility window to cover the full Feb 2020 → Feb 2022 period in one ceremony.',
    source: 'en.wikipedia.org/wiki/2022_Laurence_Olivier_Awards',
  },
  {
    ceremonyYear: 2023,
    label: '2022-23',
    start: '2022-02-23',
    end: '2023-02-14',
    lastVerified: '2026-05-16',
    notes: 'Start adjusted +1 day from the SOLT published window (21 Feb 2022) to maintain contiguity with the 2022 ceremony\'s end (22 Feb 2022). Shows that opened 21–22 Feb 2022 were eligible for both ceremonies per SOLT; for ranking purposes we assign them to the earlier season.',
    source: 'officiallondontheatre.com/news/eligible-shows-for-the-olivier-awards-2023-with-mastercard (21 Feb 2022 – 14 Feb 2023); en.wikipedia.org/wiki/2023_Laurence_Olivier_Awards',
  },
  {
    ceremonyYear: 2024,
    label: '2023-24',
    start: '2023-02-15',
    end: '2024-02-27',
    lastVerified: '2026-05-16',
    source: 'en.wikipedia.org/wiki/2024_Laurence_Olivier_Awards — eligibility cut-off 27 Feb 2024',
  },
  {
    ceremonyYear: 2025,
    label: '2024-25',
    start: '2024-02-28',
    end: '2025-02-14',
    lastVerified: '2026-05-16',
    source: 'en.wikipedia.org/wiki/2025_Laurence_Olivier_Awards; whatsonstage.com — "28 February 2024 to 14 February 2025"',
  },
  {
    ceremonyYear: 2026,
    label: '2025-26',
    start: '2025-02-15',
    end: '2026-02-17',
    lastVerified: '2026-05-16',
    source: 'whatsonstage.com/news/olivier-awards-confirms-eligibility-for-2025-and-2026-productions_1710652 ("15 February 2025 and 17 February 2026")',
  },
  {
    ceremonyYear: 2027,
    label: '2026-27',
    start: '2026-02-18',
    end: '2027-02-16',
    lastVerified: '2026-05-16',
    notes: 'PROVISIONAL — SOLT has not yet announced the 51st window. Start is day after the 50th cutoff. End is a placeholder using the recent ~mid-February trend; update when announced (typically autumn of season-start year).',
    source: 'projected — pending official 51st announcement',
  },
];

/** Map for O(1) lookup by ceremony year. */
const BY_CEREMONY_YEAR = new Map<number, OlivierSeasonRecord>(
  OLIVIER_CUTOFFS.map((s) => [s.ceremonyYear, s]),
);

const BY_LABEL = new Map<string, OlivierSeasonRecord>(
  OLIVIER_CUTOFFS.map((s) => [s.label, s]),
);

/** Returns the record for a ceremony year, or null. */
export function olivierSeasonForCeremonyYear(ceremonyYear: number): OlivierSeasonRecord | null {
  return BY_CEREMONY_YEAR.get(ceremonyYear) ?? null;
}

/** Returns the record for a season label like "2024-25", or null. */
export function olivierSeasonForLabel(label: string): OlivierSeasonRecord | null {
  return BY_LABEL.get(label) ?? null;
}

/**
 * Returns the Olivier season the given ISO date falls into, or null if before
 * the earliest tracked season or after the latest. Inclusive on both ends.
 */
export function olivierSeasonForDate(isoDate: string): OlivierSeasonRecord | null {
  for (const s of OLIVIER_CUTOFFS) {
    if (isoDate >= s.start && isoDate <= s.end) return s;
  }
  return null;
}

/**
 * Returns the "current" Olivier season — the one whose window contains today.
 * If today is past the last cutoff, returns the latest record.
 */
export function currentOlivierSeason(today: Date = new Date()): OlivierSeasonRecord | null {
  if (OLIVIER_CUTOFFS.length === 0) return null;
  const iso = today.toISOString().slice(0, 10);
  const match = olivierSeasonForDate(iso);
  if (match) return match;
  return OLIVIER_CUTOFFS[OLIVIER_CUTOFFS.length - 1];
}

/** All seasons, newest first. */
export function allOlivierSeasonsNewestFirst(): OlivierSeasonRecord[] {
  return [...OLIVIER_CUTOFFS].reverse();
}

export const FIRST_TRACKED_OLIVIER_CEREMONY_YEAR = OLIVIER_CUTOFFS[0]?.ceremonyYear ?? null;
export const LATEST_TRACKED_OLIVIER_CEREMONY_YEAR =
  OLIVIER_CUTOFFS[OLIVIER_CUTOFFS.length - 1]?.ceremonyYear ?? null;
