// Cast Changes data module
// Imports: cast-changes.json (~5 KB)

import type { ShowCastChanges, CastHistoryEntry } from './data-types';
import { applyPublicFilters } from './cast-changes-filters';
import showsData from '../../data/cast-changes.json';

interface CastChangesFile {
  lastUpdated: string;
  shows: Record<string, ShowCastChanges>;
}

const castChanges = showsData as unknown as CastChangesFile;

// Drops [AUTO-FLAGGED] unverified entries and sorts most-recent-stint-first.
export function filterPublicHistory(entries: CastHistoryEntry[]): CastHistoryEntry[] {
  return entries
    .filter(e => !e.note?.includes('[AUTO-FLAGGED]'))
    .sort((a, b) => (b.until || b.since || '').localeCompare(a.until || a.since || ''));
}

/**
 * Get cast changes data for a specific show.
 * Applies the shared public-surface filter pipeline to upcoming events:
 *  - drops [AUTO-FLAGGED] unverified
 *  - drops absences whose endDate is in the past
 *  - drops dated past events (>7 days old)
 *  - drops undated events with stale addedDate (>60 days)
 *  - dedupes by (name, type, role) keeping most recent addedDate
 *  - suppresses per-actor departures already covered by a show-level closure event
 * `history` (completed past stints) only drops [AUTO-FLAGGED] entries and is
 * sorted most-recent-first — it's an audit trail, not a live event feed.
 */
export function getCastChanges(showId: string): ShowCastChanges | undefined {
  const data = castChanges.shows[showId];
  if (!data) return undefined;

  const filtered = applyPublicFilters(data.upcoming || [], new Date());
  const history = filterPublicHistory(data.history || []);

  if (
    filtered.length === 0 &&
    history.length === 0 &&
    (!data.currentCast || data.currentCast.length === 0)
  ) {
    return undefined;
  }

  return {
    currentCast: data.currentCast,
    upcoming: filtered,
    history,
  };
}

export function getAllCastChangeShowIds(): string[] {
  return Object.keys(castChanges.shows);
}

export function getCastChangesLastUpdated(): string {
  return castChanges.lastUpdated;
}
