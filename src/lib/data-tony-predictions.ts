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
