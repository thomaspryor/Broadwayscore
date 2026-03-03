import { getBroadwayShows } from '@/lib/data-core';
import {
  getTonySeasonWindow,
  getEligibleShows,
  groupIntoCategories,
  type SerializedTonyShow,
  type TonyCategory,
} from '@/lib/data-tony-predictions';
import { BeatTheCriticsClient } from './BeatTheCriticsClient';

export const metadata = {
  title: 'Beat the Critics | TodayTix x Broadway Scorecard',
  description: 'Pick Tony Award winners and compete against top critics and the CriticScore algorithm. Win free TodayTix tickets.',
};

// Only Tier 1 for now — the Big Four categories
const TIERS = [
  {
    key: 'tier1',
    label: 'Tier 1',
    name: 'The Big Four',
    categories: ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'],
  },
];

export interface BeatTheCriticsCategoryData {
  title: string;
  nominees: SerializedTonyShow[];
}

export interface BeatTheCriticsData {
  tiers: {
    key: string;
    label: string;
    name: string;
    categories: BeatTheCriticsCategoryData[];
  }[];
  season: { label: string; ceremonyYear: number };
  stats: { reviewsScored: number; showsTracked: number; criticsTracked: number };
}

export default function BeatTheCriticsPage() {
  const allShows = getBroadwayShows();
  const season = getTonySeasonWindow();
  const eligible = getEligibleShows(allShows, season);
  const grouped = groupIntoCategories(eligible);

  // Map category titles to their data
  const categoryMap = new Map<string, TonyCategory>();
  for (const cat of grouped) {
    categoryMap.set(cat.title, cat);
  }

  // Build tier data with real nominees
  const tiers = TIERS.map(tier => ({
    key: tier.key,
    label: tier.label,
    name: tier.name,
    categories: tier.categories.map(catTitle => {
      const catData = categoryMap.get(catTitle);
      // Combine scored + upcoming, scored first
      const nominees = catData
        ? [...catData.shows, ...catData.upcoming]
        : [];
      return {
        title: catTitle,
        nominees,
      };
    }),
  }));

  // Count Tony-season-specific stats
  const eligibleCount = eligible.length;
  const totalReviews = eligible.reduce((sum, s) => sum + (s.criticScore?.reviewCount || 0), 0);

  const data: BeatTheCriticsData = {
    tiers,
    season: { label: season.label, ceremonyYear: season.ceremonyYear },
    stats: {
      reviewsScored: totalReviews || 2400,  // fallback to placeholder
      showsTracked: eligibleCount || 38,
      criticsTracked: 150,
    },
  };

  return <BeatTheCriticsClient data={data} />;
}
