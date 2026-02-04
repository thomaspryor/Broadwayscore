// Awards data module
// Imports: awards.json only (~35 KB)

import type { ShowAwards, AwardsDesignation } from './data-types';
import awardsData from '../../data/awards.json';

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

  const tony = showAwards.tony;
  if (!tony || tony.eligible === false) return 'pre-season';

  const tonyWins = tony.wins || [];
  const tonyWinCount = tonyWins.length;
  const totalNominations = tony.nominations || 0;

  const wonBestMusicalOrPlay = tonyWins.some(win =>
    ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'].includes(win)
  );

  if (wonBestMusicalOrPlay && tonyWinCount >= 6) return 'sweeper';
  if (tonyWinCount >= 3) return 'lavished';
  if (tonyWinCount >= 1) return 'recognized';
  if (totalNominations > 0) return 'nominated';
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
