// Data Loader - Reads raw data files and computes scores using the engine
// This is the interface between raw data and the computed show data

import {
  computeShowData,
  ComputedShow,
  RawShow,
  RawReview,
  RawAudience,
  RawBuzzThread,
} from './engine';

// Import raw data (these are loaded at build time for static generation)
import showsData from '../../data/shows.json';
import reviewsData from '../../data/reviews.json';
import audienceData from '../../data/audience.json';
import buzzData from '../../data/buzz.json';

// Type the imported data
const shows: RawShow[] = showsData.shows as RawShow[];
const reviews: RawReview[] = reviewsData.reviews as RawReview[];
const audience: RawAudience[] = audienceData.audience as RawAudience[];
const buzz: RawBuzzThread[] = buzzData.threads as RawBuzzThread[];

// Cache for computed shows
let computedShowsCache: ComputedShow[] | null = null;

/**
 * Get all shows with computed scores
 */
export function getAllShows(): ComputedShow[] {
  if (computedShowsCache) return computedShowsCache;

  computedShowsCache = shows.map(show =>
    computeShowData(show, reviews, audience, buzz)
  );

  return computedShowsCache;
}

/**
 * Get shows filtered by status
 */
export function getShowsByStatus(status: 'open' | 'closed' | 'previews' | 'all'): ComputedShow[] {
  const allShows = getAllShows();
  if (status === 'all') return allShows;
  return allShows.filter(show => show.status === status);
}

/**
 * Get currently running shows (default homepage view)
 */
export function getCurrentShows(): ComputedShow[] {
  return getShowsByStatus('open');
}

/**
 * Get a single show by slug
 */
export function getShowBySlug(slug: string): ComputedShow | undefined {
  return getAllShows().find(show => show.slug === slug);
}

/**
 * Get a single show by ID
 */
export function getShowById(id: string): ComputedShow | undefined {
  return getAllShows().find(show => show.id === id);
}

/**
 * Get all show slugs (for static generation)
 */
export function getAllShowSlugs(): string[] {
  return shows.map(show => show.slug);
}

/**
 * Get shows sorted by metascore
 */
export function getShowsSortedByMetascore(ascending = false): ComputedShow[] {
  return [...getAllShows()].sort((a, b) => {
    const scoreA = a.metascore ?? -1;
    const scoreB = b.metascore ?? -1;
    return ascending ? scoreA - scoreB : scoreB - scoreA;
  });
}

/**
 * Get data freshness info
 */
export function getDataFreshness() {
  return {
    showsLastUpdated: showsData._meta.lastUpdated,
    reviewsLastUpdated: reviewsData._meta.lastUpdated,
    audienceLastUpdated: audienceData._meta.lastUpdated,
    buzzLastUpdated: buzzData._meta.lastUpdated,
  };
}

/**
 * Get raw data counts for stats
 */
export function getDataStats() {
  return {
    totalShows: shows.length,
    openShows: shows.filter(s => s.status === 'open').length,
    closedShows: shows.filter(s => s.status === 'closed').length,
    totalReviews: reviews.length,
    totalAudiencePlatforms: audience.length,
    totalBuzzThreads: buzz.length,
  };
}

/**
 * Get shows by type (musical, play)
 */
export function getShowsByType(type: 'musical' | 'play'): ComputedShow[] {
  return getAllShows().filter(show => show.type === type);
}

/**
 * Get shows by theater/venue
 */
export function getShowsByTheater(theater: string): ComputedShow[] {
  return getAllShows().filter(show =>
    show.venue.toLowerCase() === theater.toLowerCase()
  );
}

/**
 * Get all unique theaters
 */
export function getAllTheaters(): { name: string; slug: string; showCount: number }[] {
  const theaterMap = new Map<string, number>();

  getAllShows().forEach(show => {
    const count = theaterMap.get(show.venue) || 0;
    theaterMap.set(show.venue, count + 1);
  });

  return Array.from(theaterMap.entries())
    .map(([name, showCount]) => ({
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, ''),
      showCount,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get theater by slug
 */
export function getTheaterBySlug(slug: string): { name: string; slug: string; shows: ComputedShow[] } | undefined {
  const theaters = getAllTheaters();
  const theater = theaters.find(t => t.slug === slug);

  if (!theater) return undefined;

  return {
    name: theater.name,
    slug: theater.slug,
    shows: getShowsByTheater(theater.name),
  };
}

/**
 * Get all unique directors
 */
export function getAllDirectors(): { name: string; slug: string; showCount: number }[] {
  const directorMap = new Map<string, number>();

  getAllShows().forEach(show => {
    const directors = show.creativeTeam?.filter(
      member => member.role.toLowerCase().includes('director')
    ) || [];

    directors.forEach(director => {
      const count = directorMap.get(director.name) || 0;
      directorMap.set(director.name, count + 1);
    });
  });

  return Array.from(directorMap.entries())
    .map(([name, showCount]) => ({
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, ''),
      showCount,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get director by slug
 */
export function getDirectorBySlug(slug: string): { name: string; slug: string; shows: ComputedShow[] } | undefined {
  const directors = getAllDirectors();
  const director = directors.find(d => d.slug === slug);

  if (!director) return undefined;

  const shows = getAllShows().filter(show =>
    show.creativeTeam?.some(
      member => member.role.toLowerCase().includes('director') &&
                member.name === director.name
    )
  );

  return {
    name: director.name,
    slug: director.slug,
    shows,
  };
}

/**
 * Get top shows by category (for "Best of" pages)
 */
export function getTopShowsByCategory(category: 'musicals' | 'plays' | 'all', limit = 10): ComputedShow[] {
  let shows = getAllShows();

  if (category === 'musicals') {
    shows = shows.filter(s => s.type === 'musical');
  } else if (category === 'plays') {
    shows = shows.filter(s => s.type === 'play');
  }

  return shows
    .filter(s => s.metascore !== null && s.metascore !== undefined)
    .sort((a, b) => (b.metascore ?? 0) - (a.metascore ?? 0))
    .slice(0, limit);
}

// Export types
export type { ComputedShow };
