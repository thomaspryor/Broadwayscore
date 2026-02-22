/**
 * Shared data logic for Tony Awards predictions and hub pages.
 * Extracted from src/app/tony-awards/page.tsx to avoid duplication.
 */

import { getBroadwayShows } from '@/lib/data-core';
import type { ComputedShow } from '@/lib/engine';

// Import commercial.json directly to avoid pulling in grosses-history.json
import commercialData from '../../data/commercial.json';
import awardsData from '../../data/awards.json';

// --- Shared Types ---

export interface SerializedTonyShow {
  slug: string;
  title: string;
  venue: string;
  openingDate: string;
  previewsStartDate?: string;
  status: string;
  compositeScore: number | null;
  reviewCount: number;
  thumbnailPath: string | null;
}

// --- Tony Season Logic ---

export interface TonySeasonWindow {
  start: string;
  end: string;
  label: string;
  ceremonyYear: number;
}

export function getTonySeasonWindow(): TonySeasonWindow {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  // Tony eligibility windows (season starts the day after previous ceremony's cutoff)
  // 2024-25 cutoff: April 27, 2025 → 2025-26 season starts April 28, 2025
  // Jan-Jun: current Tony season started previous April
  // Jul-Dec: current Tony season started this April
  if (month <= 5) {
    return {
      start: `${year - 1}-04-28`,
      end: `${year}-04-27`,
      label: `${year - 1}-${year}`,
      ceremonyYear: year,
    };
  }
  return {
    start: `${year}-04-28`,
    end: `${year + 1}-04-27`,
    label: `${year}-${year + 1}`,
    ceremonyYear: year + 1,
  };
}

// --- Data Preparation ---

export interface TonyCategory {
  key: string;
  title: string;
  description: string;
  shows: SerializedTonyShow[];
  upcoming: SerializedTonyShow[];
}

export function serializeShow(show: ComputedShow): SerializedTonyShow {
  return {
    slug: show.slug,
    title: show.title,
    venue: show.venue || '',
    openingDate: show.openingDate || '',
    previewsStartDate: show.previewsStartDate || undefined,
    status: show.status || '',
    compositeScore: show.compositeScore,
    reviewCount: show.criticScore?.reviewCount || 0,
    thumbnailPath: show.images?.thumbnail || null,
  };
}

// Tour stops explicitly ruled Tony-eligible by the Administration Committee
const TONY_ELIGIBLE_TOUR_STOPS = new Set(['mamma-mia']);

function getTourStopSlugs(): Set<string> {
  const slugs = new Set<string>();
  const shows = (commercialData as Record<string, unknown>).shows as Record<string, { designation?: string }> | undefined;
  if (!shows) return slugs;
  for (const [slug, data] of Object.entries(shows)) {
    if (data.designation === 'Tour Stop' && !TONY_ELIGIBLE_TOUR_STOPS.has(slug)) slugs.add(slug);
  }
  return slugs;
}

export function getEligibleShows(allShows: ComputedShow[], season: TonySeasonWindow): ComputedShow[] {
  const tourStops = getTourStopSlugs();
  return allShows.filter(show => {
    if (!show.openingDate) return false;
    if (show.openingDate < season.start || show.openingDate > season.end) return false;
    if (tourStops.has(show.slug)) return false;
    return true;
  });
}

export function groupIntoCategories(eligible: ComputedShow[]): TonyCategory[] {
  const categories = [
    {
      key: 'best-musical',
      title: 'Best Musical',
      description: 'New musicals eligible for the top musical prize.',
      filter: (s: ComputedShow) => s.type === 'musical' && !s.isRevival,
    },
    {
      key: 'best-play',
      title: 'Best Play',
      description: 'New plays eligible for the top play prize.',
      filter: (s: ComputedShow) => s.type === 'play' && !s.isRevival,
    },
    {
      key: 'best-revival-musical',
      title: 'Best Revival of a Musical',
      description: 'Musical revivals competing for best revival honors.',
      filter: (s: ComputedShow) => s.type === 'musical' && !!s.isRevival,
    },
    {
      key: 'best-revival-play',
      title: 'Best Revival of a Play',
      description: 'Play revivals competing for best revival honors.',
      filter: (s: ComputedShow) => s.type === 'play' && !!s.isRevival,
    },
  ];

  return categories.map(cat => {
    const matching = eligible.filter(cat.filter);

    const scored = matching
      .filter(s => s.status !== 'previews' && s.status !== 'upcoming' && (s.criticScore?.reviewCount || 0) >= 5)
      .sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0))
      .map(serializeShow);

    const upcoming = matching
      .filter(s => s.status === 'previews' || s.status === 'upcoming' || (s.criticScore?.reviewCount || 0) < 5)
      .sort((a, b) => (a.openingDate || '').localeCompare(b.openingDate || ''))
      .map(serializeShow);

    return {
      key: cat.key,
      title: cat.title,
      description: cat.description,
      shows: scored,
      upcoming,
    };
  });
}

// --- Multi-Season Support ---

const TOP_CATEGORIES = ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'] as const;

type AwardsShowEntry = {
  tony?: {
    season?: string;
    wins?: string[];
    nominatedFor?: string[];
    nominations?: number;
  };
};

function getAwardsShows(): Record<string, AwardsShowEntry> {
  return (awardsData as Record<string, unknown>).shows as Record<string, AwardsShowEntry>;
}

export function getTonySeasonWindowFor(ceremonyYear: number): TonySeasonWindow {
  return {
    start: `${ceremonyYear - 1}-04-28`,
    end: `${ceremonyYear}-04-27`,
    label: `${ceremonyYear - 1}-${ceremonyYear}`,
    ceremonyYear,
  };
}

/** Convert our label format to awards.json format: "2024-2025" → "2024-25" */
export function toAwardsSeason(label: string): string {
  const parts = label.split('-');
  return `${parts[0]}-${parts[1].slice(2)}`;
}

/** Convert awards.json format to our label: "2024-25" → "2024-2025" */
export function fromAwardsSeason(s: string): string {
  const [start, endShort] = s.split('-');
  const century = endShort === '00' ? parseInt(start.slice(0, 2)) + 1 : start.slice(0, 2);
  return `${start}-${century}${endShort}`;
}

const FIRST_PREDICTION_SEASON = 2014; // ceremony year — gives us 2013-2014 as first season

/** Returns all seasons we generate prediction pages for, most recent first. */
export function getAllPredictionSeasons(): TonySeasonWindow[] {
  const current = getTonySeasonWindow();
  const seasons: TonySeasonWindow[] = [];
  for (let cy = FIRST_PREDICTION_SEASON; cy <= current.ceremonyYear; cy++) {
    seasons.push(getTonySeasonWindowFor(cy));
  }
  return seasons.reverse();
}

/**
 * For past seasons, derive eligible shows from awards.json nominees + opening date window.
 * This handles COVID seasons where the standard date window doesn't capture all nominees.
 */
export function getEligibleShowsForPastSeason(allShows: ComputedShow[], season: TonySeasonWindow): ComputedShow[] {
  const awardsShows = getAwardsShows();
  const showMap = new Map(allShows.map(s => [s.id, s]));
  const awardsSeason = toAwardsSeason(season.label);
  const eligible = new Map<string, ComputedShow>();

  // 1. Add all shows that have Tony data for this season in awards.json
  for (const [showId, data] of Object.entries(awardsShows)) {
    if (data.tony?.season === awardsSeason) {
      const show = showMap.get(showId);
      if (show) eligible.set(show.id, show);
    }
  }

  // 2. Also add shows from the standard date window (captures non-nominated eligible shows)
  const dateEligible = getEligibleShows(allShows, season);
  for (const show of dateEligible) {
    eligible.set(show.id, show);
  }

  return Array.from(eligible.values());
}

/**
 * Get Tony outcomes for a past season: slug → 'winner' | 'nominated'.
 * Only covers the 4 main categories. Returns empty map for current/future seasons.
 */
export function getSeasonOutcomes(allShows: ComputedShow[], season: TonySeasonWindow): Record<string, 'winner' | 'nominated'> {
  const current = getTonySeasonWindow();
  if (season.ceremonyYear >= current.ceremonyYear) return {};

  const awardsShows = getAwardsShows();
  const showMap = new Map(allShows.map(s => [s.id, s]));
  const awardsSeason = toAwardsSeason(season.label);
  const outcomes: Record<string, 'winner' | 'nominated'> = {};

  for (const [showId, data] of Object.entries(awardsShows)) {
    if (data.tony?.season !== awardsSeason) continue;
    const show = showMap.get(showId);
    if (!show) continue;

    const wins = data.tony?.wins || [];
    const noms = data.tony?.nominatedFor || [];

    const wonTopCategory = wins.some(w => TOP_CATEGORIES.includes(w as typeof TOP_CATEGORIES[number]));
    const nominatedTopCategory = noms.some(n => TOP_CATEGORIES.includes(n as typeof TOP_CATEGORIES[number]));

    if (wonTopCategory) {
      outcomes[show.slug] = 'winner';
    } else if (nominatedTopCategory) {
      outcomes[show.slug] = 'nominated';
    }
  }

  return outcomes;
}

// --- Accuracy Stats ---

export interface AccuracyStats {
  rank1WinPct: number;
  top2WinPct: number;
  avgWinnerRank: number;
  byCategory: Array<{ category: string; pct: number }>;
  newWorksAccuracy: number;
  revivalsAccuracy: number;
  fieldSizeData: Array<{ label: string; pct: number; note: string }>;
  upsets: Array<{ winner: string; season: string; category: string; rank: number }>;
  seasonCount: number;
  categorySeasonCount: number;
  skippedCount: number;
}

/**
 * Dynamically compute accuracy stats across all historical prediction seasons.
 * For each season+category, ranks actual Tony NOMINEES by compositeScore and checks
 * whether the winner was the best-reviewed nominee (#1), top 2, etc.
 * This answers the meaningful question: "Among the nominees, does the best-reviewed one win?"
 */
export function computeAccuracyStats(allShows: ComputedShow[]): AccuracyStats {
  const awardsShows = getAwardsShows();
  const showMap = new Map(allShows.map(s => [s.id, s]));
  const current = getTonySeasonWindow();
  const seasons = getAllPredictionSeasons().filter(s => s.ceremonyYear < current.ceremonyYear);

  // Build winners map: awardsSeason|category → showId
  const winnersMap = new Map<string, string>();
  // Build nominees map: awardsSeason|category → showId[]
  const nomineesMap = new Map<string, string[]>();
  for (const [showId, data] of Object.entries(awardsShows)) {
    if (!data.tony?.season) continue;
    const season = data.tony.season;
    const wins = data.tony.wins || [];
    const noms = data.tony.nominatedFor || [];

    for (const cat of TOP_CATEGORIES) {
      const catStr = cat as string;
      const key = `${season}|${catStr}`;
      if (wins.includes(catStr)) {
        winnersMap.set(key, showId);
        // Winners are also nominees
        if (!nomineesMap.has(key)) nomineesMap.set(key, []);
        if (!nomineesMap.get(key)!.includes(showId)) nomineesMap.get(key)!.push(showId);
      }
      if (noms.includes(catStr)) {
        if (!nomineesMap.has(key)) nomineesMap.set(key, []);
        if (!nomineesMap.get(key)!.includes(showId)) nomineesMap.get(key)!.push(showId);
      }
    }
  }

  let totalCatSeasons = 0;
  let skipped = 0;
  let rank1Wins = 0;
  let top2Wins = 0;
  let totalWinnerRank = 0;
  const seasonSet = new Set<string>();
  const catResults: Record<string, { total: number; rank1: number }> = {};
  const fieldResults: Record<string, { total: number; rank1: number }> = {};
  const upsets: AccuracyStats['upsets'] = [];

  for (const cat of TOP_CATEGORIES) {
    catResults[cat] = { total: 0, rank1: 0 };
  }

  for (const season of seasons) {
    const awardsSeason = toAwardsSeason(season.label);

    for (const cat of TOP_CATEGORIES) {
      const key = `${awardsSeason}|${cat}`;
      const winnerShowId = winnersMap.get(key);
      if (!winnerShowId) continue; // no winner for this category-season

      const winnerShow = showMap.get(winnerShowId);
      if (!winnerShow || winnerShow.compositeScore == null) {
        skipped++;
        continue;
      }

      // Rank actual nominees for this category by compositeScore.
      // Tony categories typically have 4-5 nominees (occasionally 6).
      // Awards.json has inflated counts in some categories (shows nominated for
      // subcategories like directing within a revival, not the main award).
      // Skip category-seasons with >6 nominees as unreliable data.
      const nomineeIds = nomineesMap.get(key) || [];
      if (nomineeIds.length > 6) {
        skipped++;
        continue;
      }
      const nomineeShows = nomineeIds
        .map(id => showMap.get(id))
        .filter((s): s is ComputedShow => s != null && s.compositeScore != null)
        .sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));

      if (nomineeShows.length < 2) {
        skipped++;
        continue;
      }

      const winnerRank = nomineeShows.findIndex(s => s.id === winnerShowId) + 1;
      if (winnerRank === 0) {
        skipped++;
        continue; // winner not found among nominees (data issue)
      }

      totalCatSeasons++;
      seasonSet.add(season.label);
      catResults[cat].total++;
      totalWinnerRank += winnerRank;

      // Field size bucket (nominee count)
      const fieldSize = nomineeShows.length;
      let bucket: string;
      if (fieldSize <= 2) bucket = '2';
      else if (fieldSize <= 4) bucket = '3-4';
      else if (fieldSize <= 6) bucket = '5-6';
      else bucket = '7+';
      if (!fieldResults[bucket]) fieldResults[bucket] = { total: 0, rank1: 0 };
      fieldResults[bucket].total++;

      if (winnerRank === 1) {
        rank1Wins++;
        catResults[cat].rank1++;
        fieldResults[bucket].rank1++;
      }
      if (winnerRank <= 2) {
        top2Wins++;
      }
      if (winnerRank > 2) {
        upsets.push({
          winner: winnerShow.title,
          season: season.label,
          category: cat.replace('Best ', '').replace('Revival of a ', 'Revival '),
          rank: winnerRank,
        });
      }
    }
  }

  const byCategory = TOP_CATEGORIES.map(cat => ({
    category: cat.replace('Best ', '').replace('Revival of a ', 'Revival '),
    pct: catResults[cat].total > 0 ? Math.round((catResults[cat].rank1 / catResults[cat].total) * 100) : 0,
  }));

  // New works vs revivals
  const newCats = TOP_CATEGORIES.filter(c => !c.includes('Revival'));
  const revCats = TOP_CATEGORIES.filter(c => c.includes('Revival'));
  const newTotal = newCats.reduce((s, c) => s + catResults[c].total, 0);
  const newWins = newCats.reduce((s, c) => s + catResults[c].rank1, 0);
  const revTotal = revCats.reduce((s, c) => s + catResults[c].total, 0);
  const revWins = revCats.reduce((s, c) => s + catResults[c].rank1, 0);

  const fieldSizeData = [
    { label: '3\u20134 nominees', bucket: '3-4', note: 'Small field' },
    { label: '5\u20136 nominees', bucket: '5-6', note: '' },
    { label: '2 nominees', bucket: '2', note: 'Coin flip' },
    { label: '7+ nominees', bucket: '7+', note: 'Standard field' },
  ].map(({ label, bucket, note }) => ({
    label,
    pct: fieldResults[bucket]?.total > 0 ? Math.round((fieldResults[bucket].rank1 / fieldResults[bucket].total) * 100) : 0,
    note,
  }));

  return {
    rank1WinPct: totalCatSeasons > 0 ? Math.round((rank1Wins / totalCatSeasons) * 100) : 0,
    top2WinPct: totalCatSeasons > 0 ? Math.round((top2Wins / totalCatSeasons) * 100) : 0,
    avgWinnerRank: totalCatSeasons > 0 ? parseFloat((totalWinnerRank / totalCatSeasons).toFixed(2)) : 0,
    byCategory,
    newWorksAccuracy: newTotal > 0 ? Math.round((newWins / newTotal) * 100) : 0,
    revivalsAccuracy: revTotal > 0 ? Math.round((revWins / revTotal) * 100) : 0,
    fieldSizeData,
    upsets: upsets.sort((a, b) => b.season.localeCompare(a.season)),
    seasonCount: seasonSet.size,
    categorySeasonCount: totalCatSeasons,
    skippedCount: skipped,
  };
}

// --- Season Summary (for overview page) ---

export interface TonySeasonSummary {
  season: TonySeasonWindow;
  eligibleCount: number;
  scoredCount: number;
  isCurrent: boolean;
  hasTonyResults: boolean;
  categoryHighlights: Array<{
    category: string;
    topShowTitle: string | null;
    topShowScore: number | null;
    winnerTitle: string | null;
  }>;
}

export function getSeasonSummary(allShows: ComputedShow[], season: TonySeasonWindow): TonySeasonSummary {
  const current = getTonySeasonWindow();
  const isCurrent = season.label === current.label;
  const isPast = season.ceremonyYear < current.ceremonyYear;
  const eligible = isPast ? getEligibleShowsForPastSeason(allShows, season) : getEligibleShows(allShows, season);
  const categories = groupIntoCategories(eligible);

  const awardsShows = getAwardsShows();
  const showMap = new Map(allShows.map(s => [s.id, s]));
  const awardsSeason = toAwardsSeason(season.label);

  // Find winners per category for this season
  const winnersByCategory = new Map<string, string>();
  if (isPast) {
    for (const [showId, data] of Object.entries(awardsShows)) {
      if (data.tony?.season !== awardsSeason) continue;
      const wins = data.tony?.wins || [];
      for (const w of wins) {
        if (TOP_CATEGORIES.includes(w as typeof TOP_CATEGORIES[number])) {
          const show = showMap.get(showId);
          if (show) winnersByCategory.set(w, show.title);
        }
      }
    }
  }

  const categoryHighlights = categories.map(cat => {
    const catName = cat.title;
    const topShow = cat.shows[0] || null;
    return {
      category: catName.replace('Best ', '').replace('Revival of a ', 'Revival '),
      topShowTitle: topShow?.title || null,
      topShowScore: topShow?.compositeScore || null,
      winnerTitle: winnersByCategory.get(catName) || null,
    };
  });

  return {
    season,
    eligibleCount: eligible.length,
    scoredCount: categories.reduce((sum, cat) => sum + cat.shows.length, 0),
    isCurrent,
    hasTonyResults: winnersByCategory.size > 0,
    categoryHighlights,
  };
}

// --- Historical Winners ---

export interface HistoricalWinner {
  slug: string;
  title: string;
  season: string;
  category: string;
  compositeScore: number | null;
  reviewCount: number;
}

export function getHistoricalWinners(allShows?: ComputedShow[]): HistoricalWinner[] {
  const shows = allShows || getBroadwayShows();
  const showMap = new Map(shows.map(s => [s.id, s]));
  const winners: HistoricalWinner[] = [];
  const awardsShows = (awardsData as Record<string, unknown>).shows as Record<string, {
    tony?: { season?: string; wins?: string[] };
  }>;

  for (const [showId, data] of Object.entries(awardsShows)) {
    const wins = data.tony?.wins || [];
    const topCategory = wins.find(w =>
      ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'].includes(w)
    );
    if (!topCategory) continue;

    const show = showMap.get(showId);
    if (!show) continue;

    winners.push({
      slug: show.slug,
      title: show.title,
      season: data.tony?.season || '',
      category: topCategory,
      compositeScore: show.compositeScore,
      reviewCount: show.criticScore?.reviewCount || 0,
    });
  }

  return winners
    .sort((a, b) => b.season.localeCompare(a.season))
    .slice(0, 20);
}
