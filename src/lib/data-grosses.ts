// Box Office / Grosses data module
// Imports: grosses.json only (~112 KB)

import type { ShowGrosses } from './data-types';
import grossesData from '../../data/grosses.json';

interface GrossesFile {
  lastUpdated: string;
  weekEnding: string;
  shows: Record<string, ShowGrosses>;
}

const grosses = grossesData as GrossesFile;

/**
 * Get box office data for a specific show by slug
 */
export function getShowGrosses(slug: string): ShowGrosses | undefined {
  return grosses.shows[slug];
}

/**
 * Get the week ending date for grosses data
 */
export function getGrossesWeekEnding(): string {
  return grosses.weekEnding;
}

/**
 * Get grosses last updated timestamp
 */
export function getGrossesLastUpdated(): string {
  return grosses.lastUpdated;
}
