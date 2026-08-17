/**
 * Bridges show-domain data (watchlist entry + show record) into a
 * `PerformanceEvent` for src/lib/calendar's pure builders.
 *
 * Deliberately NOT inside src/lib/calendar/ — that directory is vendored
 * standalone into the iOS app and must stay free of show-domain imports (see
 * its module doc). This file is the one place that knows how a watchlist row
 * and a show record turn into a calendar event; everything downstream reuses it.
 */
import type { PerformanceEvent } from './calendar';
import { resolveTimeZone, resolveDurationMin, CURTAIN_BUFFER_MIN } from './calendar';

// Same fallback pattern as every other BASE_URL constant in this codebase
// (src/lib/seo.ts, src/app/sitemap.ts, ...) — inlined rather than imported so
// this stays a leaf module or breaks a client bundle in the middle of it.
const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export interface PlannedShowSource {
  id: string;
  title: string;
  slug: string;
  diaryOnly?: boolean;
  category?: string | null;
  venue?: string | null;
  theaterAddress?: string | null;
  /** Pre-parsed minutes (ShowLookup, e.g. My Shows). Preferred over `runtime` when present. */
  runtimeMin?: number | null;
  /** Raw human string (engine Show / canonical Show), e.g. "2h 30m". */
  runtime?: string | null;
}

export interface PlannedEntrySource {
  planned_date: string | null;
  /** "HH:MM" or "HH:MM:SS" (PostgREST TIME column) — either is accepted. */
  curtain_time: string | null;
}

/**
 * Builds the calendar event for a planned watchlist entry, or null when
 * there isn't enough to build one. Requires BOTH a date and a curtain time —
 * an all-day event with no showtime isn't the "Add to Calendar" the picker
 * promises, so the caller should not render the buttons without one either.
 */
export function buildPlannedShowEvent(show: PlannedShowSource, entry: PlannedEntrySource): PerformanceEvent | null {
  if (!entry.planned_date || !entry.curtain_time) return null;
  const href = show.diaryOnly ? `/diary-show/${show.slug}` : `/show/${show.slug}`;
  return {
    showId: show.id,
    title: show.title,
    date: entry.planned_date,
    time: entry.curtain_time.slice(0, 5),
    tz: resolveTimeZone(show.category),
    durationMin: typeof show.runtimeMin === 'number' && show.runtimeMin > 0
      ? show.runtimeMin + CURTAIN_BUFFER_MIN
      : resolveDurationMin(show.runtime ?? null),
    location: show.theaterAddress || show.venue || '',
    showUrl: `${BASE_URL}${href}`,
  };
}
