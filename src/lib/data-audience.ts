// Audience Buzz data module — imports ~4.4MB of JSON.
// WARNING: Client components ('use client') must NEVER import from this file.
// Use '@/lib/audience-grade-utils' for pure grade/score functions instead.

import type { AudienceBuzzDesignation, AudienceBuzzData } from './data-types';
import audienceBuzzData from '../../data/audience-buzz.json';
import showsData from '../../data/shows.json';
import showScoreUrlsData from '../../data/show-score-urls.json';

// Re-export pure functions from lightweight module for backward compat
export { getAudienceGrade, getAudienceGradeClasses, getTotalAudienceReviews, hasEnoughAudienceReviews, MIN_AUDIENCE_REVIEWS } from './audience-grade-utils';

interface AudienceBuzzFile {
  _meta: {
    lastUpdated: string;
    sources: string[];
    designationThresholds: Record<string, string>;
    notes: string;
  };
  shows: Record<string, AudienceBuzzData>;
}

const audienceBuzz = audienceBuzzData as unknown as AudienceBuzzFile;
const rawShows = showsData.shows as Array<{ id: string; slug: string }>;
const showScoreUrls = (showScoreUrlsData as Record<string, unknown>).shows as Record<string, string> | undefined;

/**
 * Get audience buzz data for a specific show by ID
 */
export function getAudienceBuzz(showId: string): AudienceBuzzData | undefined {
  return audienceBuzz.shows[showId];
}

/**
 * Get audience buzz by slug (looks up show ID first)
 */
export function getAudienceBuzzBySlug(slug: string): AudienceBuzzData | undefined {
  const show = rawShows.find(s => s.slug === slug);
  if (!show) return undefined;
  return audienceBuzz.shows[show.id];
}

/**
 * Get all shows sorted by audience buzz score
 */
export function getShowsByAudienceBuzz(limit = 10): Array<{ showId: string; data: AudienceBuzzData }> {
  const results: Array<{ showId: string; data: AudienceBuzzData }> = [];

  for (const [showId, data] of Object.entries(audienceBuzz.shows)) {
    results.push({ showId, data });
  }

  return results
    .sort((a, b) => b.data.combinedScore - a.data.combinedScore)
    .slice(0, limit);
}

/**
 * Get audience buzz designation color class
 * @deprecated Use getAudienceGradeClasses instead
 */
export function getAudienceBuzzColor(designation: AudienceBuzzDesignation): {
  bgClass: string;
  textClass: string;
  borderClass: string;
} {
  switch (designation) {
    case 'Loving':
      return {
        bgClass: 'bg-gradient-to-r from-rose-500/20 to-pink-500/20',
        textClass: 'text-rose-400',
        borderClass: 'border-rose-500/30',
      };
    case 'Liking':
      return {
        bgClass: 'bg-emerald-500/15',
        textClass: 'text-emerald-400',
        borderClass: 'border-emerald-500/25',
      };
    case 'Shrugging':
      return {
        bgClass: 'bg-amber-500/15',
        textClass: 'text-amber-400',
        borderClass: 'border-amber-500/25',
      };
    case 'Disliking':
      return {
        bgClass: 'bg-red-500/15',
        textClass: 'text-red-400',
        borderClass: 'border-red-500/25',
      };
    case 'Loathing':
      return {
        bgClass: 'bg-gray-500/15',
        textClass: 'text-gray-400',
        borderClass: 'border-white/10',
      };
  }
}

/**
 * Get the correct Show Score URL for a show (from show-score-urls.json lookup)
 */
export function getShowScoreUrl(showId: string): string | undefined {
  return showScoreUrls?.[showId] || undefined;
}

/**
 * Get the audience review page URL for a platform.
 * Returns stored URL from audience-buzz.json (populated by scrapers/backfill).
 * Show Score uses a separate curated URL map.
 */
export function getAudiencePlatformUrl(
  sourceKey: string,
  showId: string,
  _showTitle: string,
): string | undefined {
  // Show Score uses curated URL map
  if (sourceKey === 'showScore') {
    return getShowScoreUrl(showId);
  }

  // Use scraper-stored URL (no fallback generation — avoids 404s)
  const buzz = audienceBuzz.shows[showId];
  const sourceData = buzz?.sources?.[sourceKey];
  return sourceData?.url || undefined;
}

/**
 * Get audience buzz data last updated timestamp
 */
export function getAudienceBuzzLastUpdated(): string {
  return audienceBuzz._meta.lastUpdated;
}
