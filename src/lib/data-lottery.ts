// Lottery & Rush data module
// Imports: lottery-rush.json (~3 KB) + shows.json (~1.3 MB for slug→id lookup)

import type { ShowLotteryRush } from './data-types';
import lotteryRushData from '../../data/lottery-rush.json';
import showsData from '../../data/shows.json';

interface LotteryRushFile {
  lastUpdated: string;
  source: string;
  shows: Record<string, ShowLotteryRush>;
}

const lotteryRush = lotteryRushData as unknown as LotteryRushFile;
const rawShows = showsData.shows as Array<{ id: string; slug: string }>;

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
  const show = rawShows.find(s => s.slug === slug);
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
