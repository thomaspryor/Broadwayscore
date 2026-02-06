// Cast Changes data module
// Imports: cast-changes.json (~5 KB) + shows.json for slug→id lookup

import type { ShowCastChanges } from './data-types';
import showsData from '../../data/cast-changes.json';
import rawShowsData from '../../data/shows.json';

interface CastChangesFile {
  lastUpdated: string;
  shows: Record<string, ShowCastChanges>;
}

const castChanges = showsData as unknown as CastChangesFile;
const rawShows = rawShowsData.shows as Array<{ id: string; slug: string }>;

/**
 * Get cast changes data for a specific show by show ID
 */
export function getCastChanges(showId: string): ShowCastChanges | undefined {
  const data = castChanges.shows[showId];
  if (!data) return undefined;

  // Filter out auto-flagged events and past events for the public view
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  const upcoming = (data.upcoming || []).filter(event => {
    // Hide auto-flagged unverified items
    if (event.note && event.note.includes('[AUTO-FLAGGED]')) return false;

    // For events with dates, filter out ones that are well past (>7 days ago)
    // Keep recent past events briefly so users can see what just happened
    if (event.date) {
      const eventDate = new Date(event.date);
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      if (eventDate < sevenDaysAgo) return false;
    }

    return true;
  });

  // Don't return if nothing to show
  if (upcoming.length === 0 && (!data.currentCast || data.currentCast.length === 0)) {
    return undefined;
  }

  return {
    currentCast: data.currentCast,
    upcoming,
  };
}

/**
 * Get cast changes by slug
 */
export function getCastChangesBySlug(slug: string): ShowCastChanges | undefined {
  const show = rawShows.find(s => s.slug === slug);
  if (!show) return undefined;
  return getCastChanges(show.id);
}

/**
 * Check if a show has any upcoming cast changes
 */
export function hasCastChanges(showId: string): boolean {
  const data = getCastChanges(showId);
  return !!data && !!data.upcoming && data.upcoming.length > 0;
}

/**
 * Get cast changes last updated timestamp
 */
export function getCastChangesLastUpdated(): string {
  return castChanges.lastUpdated;
}
