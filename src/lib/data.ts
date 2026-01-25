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
import grossesData from '../../data/grosses.json';

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

// ============================================
// Director Queries
// ============================================

export interface Director {
  name: string;
  slug: string;
  shows: ComputedShow[];
  avgScore: number | null;
  showCount: number;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Get all unique directors with their shows
 */
export function getAllDirectors(): Director[] {
  const allShows = getAllShows();
  const directorMap = new Map<string, ComputedShow[]>();

  for (const show of allShows) {
    const directors = show.creativeTeam?.filter(m =>
      m.role.toLowerCase().includes('director') &&
      !m.role.toLowerCase().includes('music director') &&
      !m.role.toLowerCase().includes('artistic director')
    ) || [];

    for (const director of directors) {
      const existing = directorMap.get(director.name) || [];
      existing.push(show);
      directorMap.set(director.name, existing);
    }
  }

  return Array.from(directorMap.entries()).map(([name, shows]) => {
    const scoredShows = shows.filter(s => s.criticScore?.score);
    const avgScore = scoredShows.length > 0
      ? Math.round(scoredShows.reduce((sum, s) => sum + (s.criticScore?.score || 0), 0) / scoredShows.length)
      : null;

    return {
      name,
      slug: slugify(name),
      shows,
      avgScore,
      showCount: shows.length,
    };
  }).sort((a, b) => b.showCount - a.showCount);
}

/**
 * Get a single director by slug
 */
export function getDirectorBySlug(slug: string): Director | undefined {
  return getAllDirectors().find(d => d.slug === slug);
}

/**
 * Get all director slugs (for static generation)
 */
export function getAllDirectorSlugs(): string[] {
  return getAllDirectors().map(d => d.slug);
}

// ============================================
// Theater Queries
// ============================================

export interface Theater {
  name: string;
  slug: string;
  address?: string;
  currentShow?: ComputedShow;
  allShows: ComputedShow[];
  showCount: number;
}

/**
 * Get all unique theaters with their shows
 */
export function getAllTheaters(): Theater[] {
  const allShows = getAllShows();
  const theaterMap = new Map<string, { shows: ComputedShow[]; address?: string }>();

  for (const show of allShows) {
    const existing = theaterMap.get(show.venue) || { shows: [], address: show.theaterAddress };
    existing.shows.push(show);
    if (show.theaterAddress) existing.address = show.theaterAddress;
    theaterMap.set(show.venue, existing);
  }

  return Array.from(theaterMap.entries()).map(([name, data]) => {
    const currentShow = data.shows.find(s => s.status === 'open');

    return {
      name,
      slug: slugify(name),
      address: data.address,
      currentShow,
      allShows: data.shows.sort((a, b) =>
        new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime()
      ),
      showCount: data.shows.length,
    };
  }).sort((a, b) => b.showCount - a.showCount);
}

/**
 * Get a single theater by slug
 */
export function getTheaterBySlug(slug: string): Theater | undefined {
  return getAllTheaters().find(t => t.slug === slug);
}

/**
 * Get all theater slugs (for static generation)
 */
export function getAllTheaterSlugs(): string[] {
  return getAllTheaters().map(t => t.slug);
}

// ============================================
// Best-of List Queries
// ============================================

export type BestOfCategory = 'musicals' | 'plays' | 'new-shows' | 'highest-rated' | 'family' | 'comedy' | 'drama';

export interface BestOfList {
  category: BestOfCategory;
  title: string;
  description: string;
  shows: ComputedShow[];
}

const BEST_OF_CONFIG: Record<BestOfCategory, { title: string; description: string; filter: (show: ComputedShow) => boolean }> = {
  'musicals': {
    title: 'Best Broadway Musicals',
    description: 'The highest-rated musicals currently playing on Broadway, ranked by critic scores.',
    filter: (show) => (show.type === 'musical' || show.type === 'revival') && show.status === 'open',
  },
  'plays': {
    title: 'Best Broadway Plays',
    description: 'The highest-rated plays currently on Broadway, ranked by critic scores.',
    filter: (show) => show.type === 'play' && show.status === 'open',
  },
  'new-shows': {
    title: 'Best New Broadway Shows',
    description: 'The highest-rated shows that opened in the current season.',
    filter: (show) => {
      const openDate = new Date(show.openingDate);
      const seasonStart = new Date('2025-09-01'); // Current season
      return show.status === 'open' && openDate >= seasonStart;
    },
  },
  'highest-rated': {
    title: 'Top 10 Highest Rated Broadway Shows',
    description: 'The absolute best shows on Broadway right now, based on aggregated critic reviews.',
    filter: (show) => show.status === 'open' && show.criticScore?.score !== undefined,
  },
  'family': {
    title: 'Best Broadway Shows for Families',
    description: 'Family-friendly Broadway shows perfect for all ages.',
    filter: (show) => {
      const ageRec = show.ageRecommendation?.toLowerCase() || '';
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return show.status === 'open' && (
        ageRec.includes('all ages') ||
        ageRec.includes('ages 6') ||
        ageRec.includes('ages 8') ||
        tags.includes('family')
      );
    },
  },
  'comedy': {
    title: 'Best Broadway Comedies',
    description: 'The funniest shows on Broadway, from hilarious musicals to laugh-out-loud plays.',
    filter: (show) => {
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return show.status === 'open' && tags.includes('comedy');
    },
  },
  'drama': {
    title: 'Best Broadway Dramas',
    description: 'Powerful dramatic productions currently captivating Broadway audiences.',
    filter: (show) => {
      const tags = show.tags?.map(t => t.toLowerCase()) || [];
      return show.status === 'open' && tags.includes('drama');
    },
  },
};

/**
 * Get a best-of list by category
 */
export function getBestOfList(category: BestOfCategory): BestOfList | undefined {
  const config = BEST_OF_CONFIG[category];
  if (!config) return undefined;

  const allShows = getAllShows();
  const filteredShows = allShows
    .filter(config.filter)
    .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
    .slice(0, 10);

  return {
    category,
    title: config.title,
    description: config.description,
    shows: filteredShows,
  };
}

/**
 * Get all best-of categories (for static generation)
 */
export function getAllBestOfCategories(): BestOfCategory[] {
  return Object.keys(BEST_OF_CONFIG) as BestOfCategory[];
}

/**
 * Get upcoming shows (in previews or recently opened)
 */
export function getUpcomingShows(): ComputedShow[] {
  const allShows = getAllShows();
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  return allShows
    .filter(show => {
      // Shows in previews
      if (show.status === 'previews') return true;
      // Shows that opened within last 3 months
      const openDate = new Date(show.openingDate);
      return show.status === 'open' && openDate >= threeMonthsAgo;
    })
    .sort((a, b) => new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime())
    .slice(0, 8);
}

// ============================================
// Box Office / Grosses Queries
// ============================================

export interface ShowGrosses {
  thisWeek?: {
    gross: number | null;
    grossPrevWeek: number | null;
    grossYoY: number | null;
    capacity: number | null;
    capacityPrevWeek: number | null;
    capacityYoY: number | null;
    atp: number | null;
    atpPrevWeek: number | null;
    atpYoY: number | null;
    attendance: number | null;
    performances: number | null;
  };
  allTime: {
    gross: number | null;
    performances: number | null;
    attendance: number | null;
  };
  lastUpdated?: string;
}

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

// ============================================
// Browse Page Queries
// ============================================

import { BROWSE_PAGES, BrowsePageConfig, getAllBrowseSlugs as getBrowseSlugsFromConfig } from '@/config/browse-pages';

export interface BrowseList {
  config: BrowsePageConfig;
  shows: ComputedShow[];
}

/**
 * Get filtered and sorted shows for a browse page
 */
export function getBrowseList(slug: string): BrowseList | undefined {
  const config = BROWSE_PAGES[slug];
  if (!config) return undefined;

  const allShows = getAllShows();
  let filteredShows = allShows.filter(config.filter);

  // Sort shows
  if (config.sort === 'score') {
    filteredShows = filteredShows.sort((a, b) =>
      (b.criticScore?.score ?? 0) - (a.criticScore?.score ?? 0)
    );
  } else if (config.sort === 'opening-date') {
    filteredShows = filteredShows.sort((a, b) =>
      new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime()
    );
  } else if (config.sort === 'closing-date') {
    filteredShows = filteredShows.sort((a, b) => {
      if (!a.closingDate) return 1;
      if (!b.closingDate) return -1;
      return new Date(a.closingDate).getTime() - new Date(b.closingDate).getTime();
    });
  } else if (config.sort === 'title') {
    filteredShows = filteredShows.sort((a, b) =>
      a.title.localeCompare(b.title)
    );
  }

  // Apply limit if specified
  if (config.limit) {
    filteredShows = filteredShows.slice(0, config.limit);
  }

  return {
    config,
    shows: filteredShows,
  };
}

/**
 * Get all browse page slugs for static generation
 */
export function getAllBrowseSlugs(): string[] {
  return getBrowseSlugsFromConfig();
}

// Export types
export type { ComputedShow };
export type { BrowsePageConfig } from '@/config/browse-pages';
