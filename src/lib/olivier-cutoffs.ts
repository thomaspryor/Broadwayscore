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

export const OLIVIER_CUTOFFS: OlivierSeasonRecord[] = [];

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
