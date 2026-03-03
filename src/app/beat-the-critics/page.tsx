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

// Tier definitions from the spec
const TIERS = [
  {
    key: 'tier1',
    label: 'Tier 1',
    name: 'The Big Four',
    categories: ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'],
  },
  {
    key: 'tier2',
    label: 'Tier 2',
    name: 'The Performers',
    categories: ['Best Actress in a Musical', 'Best Actor in a Musical', 'Best Actress in a Play', 'Best Actor in a Play'],
  },
  {
    key: 'tier3',
    label: 'Tier 3',
    name: 'The Deep Cuts',
    categories: ['Best Direction of a Musical', 'Best Direction of a Play', 'Best Original Score', 'Best Book of a Musical'],
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

  const data: BeatTheCriticsData = {
    tiers,
    season: { label: season.label, ceremonyYear: season.ceremonyYear },
    stats: {
      reviewsScored: 14000,
      showsTracked: allShows.length,
      criticsTracked: 870,
    },
  };

  return <BeatTheCriticsClient data={data} />;
}
