// Cast Changes data module
// Imports: cast-changes.json (~5 KB)

import type { ShowCastChanges } from './data-types';
import showsData from '../../data/cast-changes.json';

interface CastChangesFile {
  lastUpdated: string;
  shows: Record<string, ShowCastChanges>;
}

const castChanges = showsData as unknown as CastChangesFile;

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
    } else if (event.addedDate) {
      // Events with no date expire after 60 days based on when they were added
      const addedDate = new Date(event.addedDate);
      const sixtyDaysAgo = new Date(now);
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      if (addedDate < sixtyDaysAgo) return false;
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
 * Get all show IDs that have cast changes data
 */
export function getAllCastChangeShowIds(): string[] {
  return Object.keys(castChanges.shows);
}

/**
 * Get cast changes last updated timestamp
 */
export function getCastChangesLastUpdated(): string {
  return castChanges.lastUpdated;
}
