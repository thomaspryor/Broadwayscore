// Cast Changes data module
// Imports: cast-changes.json (~5 KB)

import type { ShowCastChanges } from './data-types';
import { applyPublicFilters } from './cast-changes-filters';
import showsData from '../../data/cast-changes.json';

interface CastChangesFile {
  lastUpdated: string;
  shows: Record<string, ShowCastChanges>;
}

const castChanges = showsData as unknown as CastChangesFile;

/**
 * Get cast changes data for a specific show.
 * Applies the shared public-surface filter pipeline:
 *  - drops [AUTO-FLAGGED] unverified
 *  - drops absences whose endDate is in the past
 *  - drops dated past events (>7 days old)
 *  - drops undated events with stale addedDate (>60 days)
 *  - dedupes by (name, type, role) keeping most recent addedDate
 *  - suppresses per-actor departures already covered by a show-level closure event
 */
export function getCastChanges(showId: string): ShowCastChanges | undefined {
  const data = castChanges.shows[showId];
  if (!data) return undefined;

  const filtered = applyPublicFilters(data.upcoming || [], new Date());

  if (filtered.length === 0 && (!data.currentCast || data.currentCast.length === 0)) {
    return undefined;
  }

  return {
    currentCast: data.currentCast,
    upcoming: filtered,
  };
}

export function getAllCastChangeShowIds(): string[] {
  return Object.keys(castChanges.shows);
}

export function getCastChangesLastUpdated(): string {
  return castChanges.lastUpdated;
}
