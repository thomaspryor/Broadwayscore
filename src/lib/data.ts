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
import awardsData from '../../data/awards.json';
import commercialData from '../../data/commercial.json';
import grossesHistoryData from '../../data/grosses-history.json';
import audienceBuzzData from '../../data/audience-buzz.json';
import criticConsensusData from '../../data/critic-consensus.json';
import lotteryRushData from '../../data/lottery-rush.json';
import { getDesignationSortOrder } from '@/config/commercial';

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
 * Get shows sorted by composite score
 */
export function getShowsSortedByCompositeScore(ascending = false): ComputedShow[] {
  return [...getAllShows()].sort((a, b) => {
    const scoreA = a.compositeScore ?? -1;
    const scoreB = b.compositeScore ?? -1;
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
  // Sum up actual review counts from computed shows
  const allShows = getAllShows();
  const totalReviews = allShows.reduce((sum, show) => sum + (show.criticScore?.reviewCount || 0), 0);

  return {
    totalShows: shows.length,
    openShows: shows.filter(s => s.status === 'open').length,
    closedShows: shows.filter(s => s.status === 'closed').length,
    totalReviews,
    totalAudiencePlatforms: audience.length,
    totalBuzzThreads: buzz.length,
  };
}

/**
 * Get the most recent data update timestamp for a show
 * Combines timestamps from grosses, audience buzz, and reviews
 * Returns ISO string of the most recent update
 */
export function getShowLastUpdated(showId: string): string | null {
  const timestamps: Date[] = [];

  // Check grosses data
  try {
    if (grosses.lastUpdated) {
      timestamps.push(new Date(grosses.lastUpdated));
    }
  } catch { /* ignore */ }

  // Check audience buzz data
  try {
    if (audienceBuzzData?._meta?.lastUpdated) {
      timestamps.push(new Date(audienceBuzzData._meta.lastUpdated));
    }
  } catch { /* ignore */ }

  // Check critic consensus data
  try {
    if (criticConsensusData?._meta?.lastGenerated) {
      timestamps.push(new Date(criticConsensusData._meta.lastGenerated));
    }
  } catch { /* ignore */ }

  // Check reviews data
  try {
    if (reviewsData?._meta?.lastUpdated) {
      timestamps.push(new Date(reviewsData._meta.lastUpdated));
    }
  } catch { /* ignore */ }

  if (timestamps.length === 0) return null;

  // Return the most recent timestamp
  const mostRecent = new Date(Math.max(...timestamps.map(d => d.getTime())));
  return mostRecent.toISOString();
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
      // Dynamically compute current season start (Broadway seasons roughly start in September)
      const now = new Date();
      const seasonStartYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
      const seasonStart = new Date(`${seasonStartYear}-09-01`);
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
 * Get upcoming shows (in previews) - sorted by soonest opening date first
 */
export function getUpcomingShows(): ComputedShow[] {
  const allShows = getAllShows();

  return allShows
    .filter(show => show.status === 'previews')
    .sort((a, b) => new Date(a.openingDate).getTime() - new Date(b.openingDate).getTime());
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
// Awards Queries
// ============================================

export interface TonyAwards {
  season: string;
  ceremony: string;
  nominations?: number;
  wins?: string[];
  nominatedFor?: string[];
  eligible?: boolean;
  note?: string;
}

export interface DramaDeskAwards {
  season: string;
  wins: string[];
  nominations: string[] | number;
}

export interface OuterCriticsCircleAwards {
  season: string;
  wins: string[];
  nominations: number;
}

export interface DramaLeagueAwards {
  season: string;
  wins: string[];
}

export interface PulitzerPrize {
  year: number;
  category: string;
}

export interface ShowAwards {
  tony?: TonyAwards;
  dramadesk?: DramaDeskAwards;
  outerCriticsCircle?: OuterCriticsCircleAwards;
  dramaLeague?: DramaLeagueAwards;
  pulitzer?: PulitzerPrize;
  note?: string;
}

// Awards designation tiers
export type AwardsDesignation =
  | 'sweeper'           // Won Best Musical/Play + 6+ Tony wins (swept the season)
  | 'lavished'          // 3-5 Tony wins (Award Darling)
  | 'recognized'        // 1-2 Tony wins OR 4+ nominations (Award Winner)
  | 'nominated'         // Has nominations but no wins
  | 'shut-out'          // Eligible but no nominations
  | 'pre-season';       // Not yet eligible for awards

interface AwardsFile {
  _meta: {
    description: string;
    lastUpdated: string;
    sources: string[];
  };
  shows: Record<string, ShowAwards>;
}

const awards = awardsData as unknown as AwardsFile;

/**
 * Get awards data for a specific show by ID
 */
export function getShowAwards(showId: string): ShowAwards | undefined {
  return awards.shows[showId];
}

/**
 * Calculate total Tony wins for a show
 */
export function getTonyWinCount(showId: string): number {
  const showAwards = awards.shows[showId];
  return showAwards?.tony?.wins?.length || 0;
}

/**
 * Calculate total Tony nominations for a show
 */
export function getTonyNominationCount(showId: string): number {
  const showAwards = awards.shows[showId];
  return showAwards?.tony?.nominations || 0;
}

/**
 * Calculate awards designation for a show
 */
export function getAwardsDesignation(showId: string): AwardsDesignation {
  const showAwards = awards.shows[showId];

  if (!showAwards) return 'pre-season';

  // Check if Tony eligible
  const tony = showAwards.tony;
  if (!tony || tony.eligible === false) return 'pre-season';

  const tonyWins = tony.wins || [];
  const tonyWinCount = tonyWins.length;
  const totalNominations = tony.nominations || 0;

  // Check if won Best Musical/Play (the big prize)
  const wonBestMusicalOrPlay = tonyWins.some(win =>
    ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'].includes(win)
  );

  // Sweeper: Won Best Musical/Play + 6+ total Tony wins (dominated the season)
  if (wonBestMusicalOrPlay && tonyWinCount >= 6) return 'sweeper';

  // Lavished (Award Darling): 3-5 Tony wins
  if (tonyWinCount >= 3) return 'lavished';

  // Recognized (Award Winner): 1-2 Tony wins OR 4+ nominations
  if (tonyWinCount >= 1 || totalNominations >= 4) return 'recognized';

  // Nominated: Has nominations but no wins
  if (totalNominations > 0) return 'nominated';

  // Shut-out: Eligible but no nominations
  return 'shut-out';
}

/**
 * Get shows with the most Tony wins
 */
export function getShowsByTonyWins(limit = 10): Array<{ showId: string; wins: number; nominations: number }> {
  const results: Array<{ showId: string; wins: number; nominations: number }> = [];

  for (const [showId, showAwards] of Object.entries(awards.shows)) {
    const wins = showAwards.tony?.wins?.length || 0;
    const nominations = showAwards.tony?.nominations || 0;
    if (wins > 0 || nominations > 0) {
      results.push({ showId, wins, nominations });
    }
  }

  return results
    .sort((a, b) => b.wins - a.wins || b.nominations - a.nominations)
    .slice(0, limit);
}

/**
 * Check if show won Best Musical or Best Play Tony
 */
export function isTopTonyWinner(showId: string): boolean {
  const showAwards = awards.shows[showId];
  const wins = showAwards?.tony?.wins || [];
  return wins.includes('Best Musical') || wins.includes('Best Play') || wins.includes('Best Revival of a Musical') || wins.includes('Best Revival of a Play');
}

/**
 * Get awards data last updated timestamp
 */
export function getAwardsLastUpdated(): string {
  return awards._meta.lastUpdated;
}

// ============================================
// Audience Buzz Data
// ============================================

export type AudienceBuzzDesignation = 'Loving' | 'Liking' | 'Shrugging' | 'Loathing';

export interface AudienceBuzzSource {
  score: number;
  reviewCount: number;
  starRating?: number;  // Only for Mezzanine (X.X out of 5)
}

export interface AudienceBuzzData {
  title: string;
  designation: AudienceBuzzDesignation;
  combinedScore: number;  // INTERNAL USE ONLY - Never display numeric scores to users, only show designation
  sources: {
    showScore: AudienceBuzzSource | null;
    mezzanine: AudienceBuzzSource | null;
    reddit: AudienceBuzzSource | null;
  };
}

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
  const show = getShowBySlug(slug);
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
 * Compute audience letter grade from combinedScore.
 * Grade scale shifted down 2 points from standard academic.
 */
export function getAudienceGrade(score: number): {
  grade: string;
  color: string;
  tooltip: string;
} {
  if (score >= 93) return { grade: 'A+', color: '#22c55e', tooltip: 'Audiences love it' };
  if (score >= 88) return { grade: 'A', color: '#16a34a', tooltip: 'Audiences love it' };
  if (score >= 83) return { grade: 'A-', color: '#14b8a6', tooltip: 'Strong audience reception' };
  if (score >= 78) return { grade: 'B+', color: '#0ea5e9', tooltip: 'Solid audience reception' };
  if (score >= 73) return { grade: 'B', color: '#f59e0b', tooltip: 'Mixed-positive reception' };
  if (score >= 68) return { grade: 'B-', color: '#f97316', tooltip: 'Mixed audience reception' };
  if (score >= 63) return { grade: 'C+', color: '#ef4444', tooltip: 'Below-average reception' };
  if (score >= 58) return { grade: 'C', color: '#dc2626', tooltip: 'Weak audience reception' };
  if (score >= 53) return { grade: 'C-', color: '#b91c1c', tooltip: 'Poor audience reception' };
  if (score >= 48) return { grade: 'D', color: '#991b1b', tooltip: 'Very poor reception' };
  return { grade: 'F', color: '#6b7280', tooltip: 'Audiences dislike it' };
}

/**
 * Get Tailwind classes for an audience grade badge (used in AudienceBuzzCard).
 */
export function getAudienceGradeClasses(score: number): {
  bgClass: string;
  textClass: string;
  borderClass: string;
} {
  const { grade } = getAudienceGrade(score);
  if (grade.startsWith('A')) return { bgClass: 'bg-green-500/15', textClass: 'text-green-400', borderClass: 'border-green-500/25' };
  if (grade === 'B+') return { bgClass: 'bg-sky-500/15', textClass: 'text-sky-400', borderClass: 'border-sky-500/25' };
  if (grade === 'B') return { bgClass: 'bg-amber-500/15', textClass: 'text-amber-400', borderClass: 'border-amber-500/25' };
  if (grade === 'B-') return { bgClass: 'bg-orange-500/15', textClass: 'text-orange-400', borderClass: 'border-orange-500/25' };
  if (grade.startsWith('C')) return { bgClass: 'bg-red-500/15', textClass: 'text-red-400', borderClass: 'border-red-500/25' };
  return { bgClass: 'bg-gray-500/15', textClass: 'text-gray-400', borderClass: 'border-gray-500/25' };
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
    case 'Loathing':
      return {
        bgClass: 'bg-gray-500/15',
        textClass: 'text-gray-400',
        borderClass: 'border-gray-500/25',
      };
  }
}

/**
 * Get audience buzz data last updated timestamp
 */
export function getAudienceBuzzLastUpdated(): string {
  return audienceBuzz._meta.lastUpdated;
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
  } else if (config.sort === 'opening-date-asc') {
    filteredShows = filteredShows.sort((a, b) =>
      new Date(a.openingDate).getTime() - new Date(b.openingDate).getTime()
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
  } else if (config.sort === 'performances') {
    filteredShows = filteredShows.sort((a, b) => {
      const aGrosses = getShowGrosses(a.slug);
      const bGrosses = getShowGrosses(b.slug);
      const aPerf = aGrosses?.allTime?.performances ?? 0;
      const bPerf = bGrosses?.allTime?.performances ?? 0;
      return bPerf - aPerf;
    });
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

// ============================================
// Commercial / Biz Buzz Queries
// ============================================

export type CommercialDesignation =
  | 'Miracle'      // Long-running mega-hit -- extraordinary returns
  | 'Windfall'     // Solid hit -- recouped and profitable
  | 'Trickle'      // Broke even or modest profit over time
  | 'Easy Winner'  // Limited run that made money, limited downside, limited upside
  | 'Fizzle'       // Closed without recouping (~30%+ recovered)
  | 'Flop'         // Closed without recouping (~<30% recovered)
  | 'Nonprofit'    // Produced by nonprofit theater (LCT, MTC, Second Stage, etc.)
  | 'TBD'          // Too early to tell
  | 'Tour Stop';   // National tour engagement on Broadway

export type CostMethodologyType =
  | 'reddit-standard'      // Reddit analyst methodology (may exclude theater cut)
  | 'trade-reported'       // Trade press reported figures
  | 'sec-filing'           // Official SEC Form D filings
  | 'producer-confirmed'   // Direct producer confirmation
  | 'deep-research'        // Verified through extensive research
  | 'industry-estimate';   // General industry estimate

export interface DeepResearchMetadata {
  verifiedFields: string[];    // Fields that have been verified (e.g., ['estimatedRecoupmentPct', 'weeklyRunningCost'])
  verifiedDate: string;        // ISO date when verification was done
  verifiedBy?: string;         // Optional: who verified (e.g., 'manual', 'claude-deep-research')
  notes?: string;              // Optional: verification notes
}

export interface ShowCommercial {
  designation: CommercialDesignation;
  capitalization: number | null;
  capitalizationSource: string | null;
  capitalActual?: number;
  capitalActualSource?: string;
  weeklyRunningCost: number | null;
  recouped: boolean | null;
  recoupedDate: string | null;
  recoupedWeeks: number | null;
  recoupedSource?: string | null;
  nonprofitOrg?: string;  // For Nonprofit designation: LCT, MTC, Second Stage, etc.
  notes?: string;
  estimatedRecoupmentPct?: [number, number] | null;
  estimatedRecoupmentSource?: string | null;
  estimatedRecoupmentDate?: string | null;
  weeklyRunningCostSource?: string | null;
  isEstimate?: {
    capitalization?: boolean;
    weeklyRunningCost?: boolean;
    recouped?: boolean;
  };
  productionType?: 'original' | 'tour-stop' | 'return-engagement';
  originalProductionId?: string;
  costMethodology?: CostMethodologyType;
  profitMargin?: number | null;
  investorMultiple?: number | null;
  insiderProfitSharePct?: number | null;
  sources?: Array<{
    type: 'trade' | 'reddit' | 'sec' | 'manual';
    url: string;
    date: string;
    excerpt?: string;
  }>;
  deepResearch?: DeepResearchMetadata;
}

interface CommercialFile {
  _meta: {
    description: string;
    lastUpdated: string;
    sources: string;
    designations: Record<string, string>;
  };
  shows: Record<string, ShowCommercial>;
}

const commercial = commercialData as unknown as CommercialFile;

/**
 * Calculate weeks to recoup from opening date and recoup date
 * This is the source of truth - never use manually stored recoupedWeeks
 */
export function calculateWeeksToRecoup(openingDate: string | null, recoupedDate: string | null): number | null {
  if (!openingDate || !recoupedDate) return null;

  try {
    const openDate = new Date(openingDate);
    if (isNaN(openDate.getTime())) return null;

    // Parse recoup date (formats: "YYYY-MM" or "YYYY")
    let recoupDate: Date;
    if (/^\d{4}-\d{2}$/.test(recoupedDate)) {
      // YYYY-MM format - use last day of month
      const [year, month] = recoupedDate.split('-');
      recoupDate = new Date(parseInt(year), parseInt(month), 0); // Last day of month
    } else if (/^\d{4}$/.test(recoupedDate)) {
      // YYYY format - use end of year
      recoupDate = new Date(parseInt(recoupedDate), 11, 31);
    } else {
      return null;
    }

    if (isNaN(recoupDate.getTime())) return null;

    const diffMs = recoupDate.getTime() - openDate.getTime();
    if (diffMs < 0) return null; // Recoup date before opening?

    return Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
  } catch {
    return null;
  }
}

/**
 * Get commercial data for a specific show by slug
 */
export function getShowCommercial(slug: string): ShowCommercial | undefined {
  return commercial.shows[slug];
}

/**
 * Get commercial designation for a show by slug
 */
export function getCommercialDesignation(slug: string): CommercialDesignation | undefined {
  return commercial.shows[slug]?.designation;
}

/**
 * Check if a show has recouped its investment (by slug)
 */
export function hasRecouped(slug: string): boolean | null {
  return commercial.shows[slug]?.recouped ?? null;
}

/**
 * Get capitalization for a show by slug
 */
export function getCapitalization(slug: string): number | null {
  return commercial.shows[slug]?.capitalization ?? null;
}

/**
 * Get show slugs by commercial designation
 */
export function getShowsByDesignation(designation: CommercialDesignation): string[] {
  const results: string[] = [];
  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (data.designation === designation) {
      results.push(slug);
    }
  }
  return results;
}

/**
 * Get all shows that have recouped (returns slugs)
 */
export function getRecoupedShows(): Array<{ slug: string; capitalization: number | null; recoupedDate: string | null }> {
  const results: Array<{ slug: string; capitalization: number | null; recoupedDate: string | null }> = [];
  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (data.recouped === true) {
      results.push({
        slug,
        capitalization: data.capitalization,
        recoupedDate: data.recoupedDate,
      });
    }
  }
  return results.sort((a, b) => {
    if (!a.recoupedDate) return 1;
    if (!b.recoupedDate) return -1;
    return new Date(b.recoupedDate).getTime() - new Date(a.recoupedDate).getTime();
  });
}

/**
 * Get all show slugs that have commercial data
 */
export function getAllCommercialSlugs(): string[] {
  return Object.keys(commercial.shows);
}

/**
 * Get commercial data last updated timestamp
 */
export function getCommercialLastUpdated(): string {
  return commercial._meta.lastUpdated;
}

/**
 * Get commercial designation description
 */
export function getDesignationDescription(designation: CommercialDesignation): string {
  return commercial._meta.designations[designation] || '';
}

// ============================================
// Biz Dashboard / Investment Tracker
// ============================================

// Type for grosses history data
interface GrossesHistoryWeek {
  gross: number | null;
  capacity: number | null;
  atp: number | null;
  attendance: number | null;
  performances: number | null;
}

interface GrossesHistoryFile {
  _meta: {
    description: string;
    lastUpdated: string;
  };
  weeks: Record<string, Record<string, GrossesHistoryWeek>>;
}

const grossesHistory = grossesHistoryData as unknown as GrossesHistoryFile;

// New types for biz dashboard
export type RecoupmentTrend = 'improving' | 'steady' | 'declining' | 'unknown';

export interface SeasonStats {
  season: string;
  capitalAtRisk: number;
  recoupedCount: number;
  totalShows: number;
  recoupedShows: string[];
}

export interface ApproachingRecoupmentShow {
  slug: string;
  title: string;
  season: string;
  capitalization: number;
  estimatedRecoupmentPct: [number, number];
  trend: RecoupmentTrend;
  weeklyGross: number | null;
}

export interface AtRiskShow {
  slug: string;
  title: string;
  season: string;
  capitalization: number;
  weeklyGross: number;
  weeklyRunningCost: number;
  trend: RecoupmentTrend;
}

export interface RecentRecoupmentShow {
  slug: string;
  title: string;
  season: string;
  weeksToRecoup: number;
  capitalization: number;
  recoupDate: string;
}

/**
 * Get Broadway season for a given date
 * Broadway seasons run July 1 - June 30
 * Returns format: "2024-2025"
 */
export function getSeason(dateString: string | null | undefined): string | null {
  if (!dateString) return null;

  const date = new Date(dateString);
  if (isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed (0 = January)

  // July (6) through December (11) = first year of season
  // January (0) through June (5) = second year of season
  if (month >= 6) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

/**
 * Get all seasons that have commercial data, sorted by most recent first
 * Automatically discovers seasons from the data - no hardcoding needed
 */
export function getSeasonsWithCommercialData(): string[] {
  const allShows = getAllShows();
  const seasonsSet = new Set<string>();

  for (const slug of Object.keys(commercial.shows)) {
    const show = allShows.find(s => s.slug === slug);
    if (!show) continue;

    const season = getSeason(show.openingDate);
    if (season) {
      seasonsSet.add(season);
    }
  }

  // Sort by season (most recent first)
  // Season format: "2024-2025", so we can sort alphabetically descending
  return Array.from(seasonsSet).sort((a, b) => b.localeCompare(a));
}

/**
 * Get season statistics: capital at risk, recoupment count, etc.
 */
export function getSeasonStats(season: string): SeasonStats {
  const allShows = getAllShows();
  const recoupedShowsList: string[] = [];
  let capitalAtRisk = 0;
  let recoupedCount = 0;
  let totalShows = 0;

  for (const [slug, data] of Object.entries(commercial.shows)) {
    // Get show info
    const show = allShows.find(s => s.slug === slug);
    if (!show) continue;

    // Check if show is in this season
    const showSeason = getSeason(show.openingDate);
    if (showSeason !== season) continue;

    // Skip non-commercial designations
    if (data.designation === 'Nonprofit' || data.designation === 'Tour Stop') continue;

    totalShows++;

    if (data.recouped === true) {
      recoupedCount++;
      recoupedShowsList.push(show.title);
    } else if (
      data.designation === 'TBD' &&
      show.status === 'open' &&
      data.capitalization
    ) {
      // Capital at risk: TBD shows still running with known capitalization
      capitalAtRisk += data.capitalization;
    }
  }

  return {
    season,
    capitalAtRisk,
    recoupedCount,
    totalShows,
    recoupedShows: recoupedShowsList,
  };
}

/**
 * Get recoupment trend for a show based on recent grosses history
 * Uses last 4 weeks of data, calculates average WoW change
 */
export function getRecoupmentTrend(slug: string): RecoupmentTrend {
  // Get sorted week keys (most recent first)
  const weekKeys = Object.keys(grossesHistory.weeks).sort().reverse();

  if (weekKeys.length < 3) return 'unknown';

  // Get last 4 weeks of gross data for this show
  const grosses: number[] = [];
  for (let i = 0; i < Math.min(4, weekKeys.length); i++) {
    const weekData = grossesHistory.weeks[weekKeys[i]]?.[slug];
    if (weekData?.gross) {
      grosses.push(weekData.gross);
    }
  }

  // Need at least 3 data points to calculate trend
  if (grosses.length < 3) return 'unknown';

  // Calculate week-over-week percentage changes
  // grosses[0] is most recent, so we compare grosses[i] to grosses[i+1]
  const wowChanges: number[] = [];
  for (let i = 0; i < grosses.length - 1; i++) {
    const current = grosses[i];
    const previous = grosses[i + 1];
    if (previous > 0) {
      const change = ((current - previous) / previous) * 100;
      wowChanges.push(change);
    }
  }

  if (wowChanges.length === 0) return 'unknown';

  // Calculate average WoW change
  const avgChange = wowChanges.reduce((a, b) => a + b, 0) / wowChanges.length;

  // Categorize based on threshold
  if (avgChange > 2) return 'improving';
  if (avgChange < -2) return 'declining';
  return 'steady';
}

/**
 * Get shows approaching recoupment (TBD with 40%+ recoupment estimate, not declining)
 */
export function getShowsApproachingRecoupment(): ApproachingRecoupmentShow[] {
  const allShows = getAllShows();
  const results: ApproachingRecoupmentShow[] = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    // Only TBD shows with estimated recoupment percentage
    if (data.designation !== 'TBD') continue;
    if (!data.estimatedRecoupmentPct) continue;

    // Lower bound must be >= 40%
    const [lower] = data.estimatedRecoupmentPct;
    if (lower < 40) continue;

    const show = allShows.find(s => s.slug === slug);
    if (!show || show.status !== 'open') continue;

    const trend = getRecoupmentTrend(slug);
    if (trend === 'declining') continue;

    // Get latest weekly gross
    const grossData = getShowGrosses(slug);

    results.push({
      slug,
      title: show.title,
      season: getSeason(show.openingDate) || 'Unknown',
      capitalization: data.capitalization || 0,
      estimatedRecoupmentPct: data.estimatedRecoupmentPct,
      trend,
      weeklyGross: grossData?.thisWeek?.gross || null,
    });
  }

  // Sort by estimated recoupment % descending (use upper bound)
  return results.sort((a, b) => b.estimatedRecoupmentPct[1] - a.estimatedRecoupmentPct[1]);
}

/**
 * Get shows truly at risk (below break-even AND below 30% recouped)
 *
 * This uses strict criteria to avoid flagging shows that are just in
 * seasonal slow periods (Jan/Feb are historically slow on Broadway).
 * A show must be BOTH losing money weekly AND far from recoupment.
 */
export function getShowsAtRisk(): AtRiskShow[] {
  const allShows = getAllShows();
  const results: AtRiskShow[] = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    // Only TBD shows (not yet recouped)
    if (data.designation !== 'TBD') continue;

    const show = allShows.find(s => s.slug === slug);
    if (!show || show.status !== 'open') continue;

    const trend = getRecoupmentTrend(slug);
    const grossData = getShowGrosses(slug);
    const weeklyGross = grossData?.thisWeek?.gross;
    const weeklyRunningCost = data.weeklyRunningCost;

    if (!weeklyGross || !weeklyRunningCost) continue;

    // Strict criteria: BOTH conditions must be true
    // 1. Actually below break-even (losing money weekly)
    const isBelowBreakEven = weeklyGross < weeklyRunningCost;

    // 2. Below 30% recouped (far from recoupment)
    // estimatedRecoupmentPct is [low, high] tuple - use high estimate for this check
    const estRecoupmentHigh = data.estimatedRecoupmentPct?.[1] || 0;
    const isBelowRecoupmentThreshold = estRecoupmentHigh < 30;

    // Must meet BOTH criteria to be truly "at risk"
    if (!isBelowBreakEven || !isBelowRecoupmentThreshold) continue;

    results.push({
      slug,
      title: show.title,
      season: getSeason(show.openingDate) || 'Unknown',
      capitalization: data.capitalization || 0,
      weeklyGross,
      weeklyRunningCost,
      trend,
    });
  }

  // Sort by severity: largest weekly deficit first
  return results.sort((a, b) => {
    const deficitA = a.weeklyRunningCost - a.weeklyGross;
    const deficitB = b.weeklyRunningCost - b.weeklyGross;
    return deficitB - deficitA;
  });
}

/**
 * Get shows that recouped within the specified number of months
 */
export function getRecentRecoupments(months: number = 24): RecentRecoupmentShow[] {
  const allShows = getAllShows();
  const results: RecentRecoupmentShow[] = [];
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);

  for (const [slug, data] of Object.entries(commercial.shows)) {
    if (!data.recouped || !data.recoupedDate) continue;

    // Parse recoup date (formats vary: "2025-01", "2024-06", "2022-12")
    const recoupDate = new Date(data.recoupedDate + '-01'); // Add day for parsing
    if (isNaN(recoupDate.getTime()) || recoupDate < cutoffDate) continue;

    const show = allShows.find(s => s.slug === slug);
    if (!show) continue;

    // Calculate weeks from opening date to recoup date (source of truth)
    const weeksToRecoup = calculateWeeksToRecoup(show.openingDate, data.recoupedDate);
    if (weeksToRecoup === null) continue;

    results.push({
      slug,
      title: show.title,
      season: getSeason(show.openingDate) || 'Unknown',
      weeksToRecoup,
      capitalization: data.capitalization || 0,
      recoupDate: data.recoupedDate,
    });
  }

  // Sort by recoup date descending (most recent first)
  return results.sort((a, b) => {
    return new Date(b.recoupDate).getTime() - new Date(a.recoupDate).getTime();
  });
}

export interface RecentClosing {
  slug: string;
  title: string;
  closingDate: string;
  designation: CommercialDesignation;
  wasFlop: boolean;
}

/**
 * Get shows that recently closed without recouping (flops/fizzles)
 */
export function getRecentClosings(months: number = 6): RecentClosing[] {
  const allShows = getAllShows();
  const results: RecentClosing[] = [];
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);

  for (const show of allShows) {
    if (show.status !== 'closed' || !show.closingDate) continue;

    const closingDate = new Date(show.closingDate);
    if (isNaN(closingDate.getTime()) || closingDate < cutoffDate) continue;
    if (closingDate > new Date()) continue; // Skip future closing dates

    const data = commercial.shows[show.slug];
    if (!data) continue;

    // Only include shows that didn't recoup
    if (data.recouped === true) continue;

    const wasFlop = data.designation === 'Flop' || data.designation === 'Fizzle';

    results.push({
      slug: show.slug,
      title: show.title,
      closingDate: show.closingDate,
      designation: data.designation,
      wasFlop,
    });
  }

  // Sort by closing date descending
  return results.sort((a, b) => {
    return new Date(b.closingDate).getTime() - new Date(a.closingDate).getTime();
  });
}

export interface UpcomingClosing {
  slug: string;
  title: string;
  closingDate: string;
  designation: CommercialDesignation;
}

/**
 * Get shows with announced upcoming closing dates
 */
export function getUpcomingClosings(): UpcomingClosing[] {
  const allShows = getAllShows();
  const results: UpcomingClosing[] = [];
  const now = new Date();
  const twoMonthsOut = new Date();
  twoMonthsOut.setMonth(twoMonthsOut.getMonth() + 2);

  for (const show of allShows) {
    if (show.status !== 'open' || !show.closingDate) continue;

    const closingDate = new Date(show.closingDate);
    if (isNaN(closingDate.getTime())) continue;
    if (closingDate <= now || closingDate > twoMonthsOut) continue;

    const data = commercial.shows[show.slug];
    if (!data) continue;

    results.push({
      slug: show.slug,
      title: show.title,
      closingDate: show.closingDate,
      designation: data.designation,
    });
  }

  // Sort by closing date ascending (soonest first)
  return results.sort((a, b) => {
    return new Date(a.closingDate).getTime() - new Date(b.closingDate).getTime();
  });
}

/**
 * Get all open shows with commercial data for the full table
 */
export function getAllOpenShowsWithCommercial(): Array<{
  slug: string;
  title: string;
  designation: CommercialDesignation;
  capitalization: number | null;
  weeklyGross: number | null;
  totalGross: number | null;
  estimatedRecoupmentPct: [number, number] | null;
  trend: RecoupmentTrend;
  recouped: boolean | null;
  recoupedWeeks: number | null;
}> {
  const allShows = getAllShows();
  const results: Array<{
    slug: string;
    title: string;
    designation: CommercialDesignation;
    capitalization: number | null;
    weeklyGross: number | null;
    totalGross: number | null;
    estimatedRecoupmentPct: [number, number] | null;
    trend: RecoupmentTrend;
    recouped: boolean | null;
    recoupedWeeks: number | null;
  }> = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = allShows.find(s => s.slug === slug);
    if (!show || show.status !== 'open') continue;

    const grossData = getShowGrosses(slug);

    results.push({
      slug,
      title: show.title,
      designation: data.designation,
      capitalization: data.capitalization,
      weeklyGross: grossData?.thisWeek?.gross || null,
      totalGross: grossData?.allTime?.gross || null,
      estimatedRecoupmentPct: data.estimatedRecoupmentPct || null,
      trend: getRecoupmentTrend(slug),
      recouped: data.recouped,
      // Calculate weeks from dates - this is the source of truth
      recoupedWeeks: calculateWeeksToRecoup(show.openingDate, data.recoupedDate),
    });
  }

  return results;
}

/**
 * Get all shows from a specific season with commercial data
 * Includes both open and closed shows
 */
export function getShowsBySeasonWithCommercial(season: string): Array<{
  slug: string;
  title: string;
  status: 'open' | 'closed' | 'previews';
  designation: CommercialDesignation;
  capitalization: number | null;
  weeklyGross: number | null;
  totalGross: number | null;
  estimatedRecoupmentPct: [number, number] | null;
  trend: RecoupmentTrend;
  recouped: boolean | null;
  recoupedWeeks: number | null;
}> {
  const allShows = getAllShows();
  const results: Array<{
    slug: string;
    title: string;
    status: 'open' | 'closed' | 'previews';
    designation: CommercialDesignation;
    capitalization: number | null;
    weeklyGross: number | null;
    totalGross: number | null;
    estimatedRecoupmentPct: [number, number] | null;
    trend: RecoupmentTrend;
    recouped: boolean | null;
    recoupedWeeks: number | null;
  }> = [];

  for (const [slug, data] of Object.entries(commercial.shows)) {
    const show = allShows.find(s => s.slug === slug);
    if (!show) continue;

    // Check if show is in this season
    const showSeason = getSeason(show.openingDate);
    if (showSeason !== season) continue;

    const grossData = getShowGrosses(slug);

    results.push({
      slug,
      title: show.title,
      status: show.status as 'open' | 'closed' | 'previews',
      designation: data.designation,
      capitalization: data.capitalization,
      weeklyGross: grossData?.thisWeek?.gross || null,
      totalGross: grossData?.allTime?.gross || null,
      estimatedRecoupmentPct: data.estimatedRecoupmentPct || null,
      trend: getRecoupmentTrend(slug),
      recouped: data.recouped,
      // Calculate weeks from dates - this is the source of truth
      recoupedWeeks: calculateWeeksToRecoup(show.openingDate, data.recoupedDate),
    });
  }

  // Sort by designation (best first), then by title
  return results.sort((a, b) => {
    const orderDiff = getDesignationSortOrder(a.designation) - getDesignationSortOrder(b.designation);
    if (orderDiff !== 0) return orderDiff;
    return a.title.localeCompare(b.title);
  });
}

// ============================================
// Critic Consensus Queries
// ============================================

export interface CriticConsensus {
  text: string;
  lastUpdated: string;
  reviewCount: number;
}

interface CriticConsensusFile {
  _meta: {
    description: string;
    lastGenerated: string | null;
    updatePolicy: string;
  };
  shows: Record<string, CriticConsensus>;
}

const criticConsensus = criticConsensusData as unknown as CriticConsensusFile;

/**
 * Get critic consensus for a specific show by ID
 */
export function getCriticConsensus(showId: string): CriticConsensus | undefined {
  return criticConsensus.shows[showId];
}

/**
 * Get critic consensus last generated timestamp
 */
export function getCriticConsensusLastUpdated(): string | null {
  return criticConsensus._meta.lastGenerated;
}

// ============================================
// Lottery & Rush Data
// ============================================

export interface LotteryInfo {
  type: string;
  platform: string;
  url: string;
  price: number;
  time: string;
  instructions: string;
}

export interface RushInfo {
  type: string;
  platform?: string;
  url?: string;
  price: number;
  time: string;
  location?: string;
  instructions: string;
}

export interface StandingRoomInfo {
  price: number;
  time: string;
  instructions: string;
}

export interface SpecialLotteryInfo {
  name: string;
  platform: string;
  url: string;
  price: number;
  instructions: string;
}

export interface ShowLotteryRush {
  lottery: LotteryInfo | null;
  rush: RushInfo | null;
  digitalRush?: RushInfo | null;
  studentRush?: RushInfo | null;
  standingRoom: StandingRoomInfo | null;
  specialLottery?: SpecialLotteryInfo | null;
}

interface LotteryRushFile {
  lastUpdated: string;
  source: string;
  shows: Record<string, ShowLotteryRush>;
}

const lotteryRush = lotteryRushData as unknown as LotteryRushFile;

/**
 * Get lottery/rush data for a specific show by ID
 */
export function getLotteryRush(showId: string): ShowLotteryRush | undefined {
  return lotteryRush.shows[showId];
}

/**
 * Get lottery/rush data by slug (looks up show ID first)
 */
export function getLotteryRushBySlug(slug: string): ShowLotteryRush | undefined {
  const show = getShowBySlug(slug);
  if (!show) return undefined;
  return lotteryRush.shows[show.id];
}

/**
 * Check if a show has any lottery/rush options
 */
export function hasLotteryOrRush(showId: string): { hasLottery: boolean; hasRush: boolean; hasSRO: boolean } {
  const data = lotteryRush.shows[showId];
  if (!data) return { hasLottery: false, hasRush: false, hasSRO: false };

  return {
    hasLottery: !!data.lottery || !!data.specialLottery,
    hasRush: !!data.rush || !!data.digitalRush || !!data.studentRush,
    hasSRO: !!data.standingRoom,
  };
}

/**
 * Get lottery/rush data last updated timestamp
 */
export function getLotteryRushLastUpdated(): string {
  return lotteryRush.lastUpdated;
}

// Export types
export type { ComputedShow };
export type { BrowsePageConfig } from '@/config/browse-pages';
