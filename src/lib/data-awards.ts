// Awards data module
// Imports: awards.json (~612 KB) — server-only. Never import this from a
// client component. For client filtering, see getAwardWinnerSets() which
// returns small ID arrays meant to be passed as props.

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
 * Check if Tony nominations have NOT yet been announced for a given season.
 * Season format: "2025-26" → ceremony year 2026. Noms announced late April/early May.
 */
function isPreNominations(season: string): boolean {
  const parts = season.split('-');
  if (parts.length !== 2) return false;
  const endPart = parseInt(parts[1], 10);
  const ceremonyYear = endPart < 100 ? 2000 + endPart : endPart;
  // Nominations typically announced late April / early May
  return new Date() < new Date(ceremonyYear, 4, 1); // Before May 1
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
  if (tony.season && isPreNominations(tony.season)) return 'pre-season';
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

/**
 * Pre-compute the set of show IDs that won/were nominated for each award.
 * Called once per page server-side; the resulting arrays ship to the client
 * (~hundreds of strings) instead of the full 600KB awards.json blob.
 *
 * Predicates in src/lib/show-filter-predicates.ts consume these via
 * FilterPredicateCtx (Sets reconstructed client-side from the arrays).
 */
export interface AwardWinnerSets {
  tonyWinnerIds: string[];
  tonyNomineeIds: string[];
  olivierWinnerIds: string[];
  olivierNomineeIds: string[];
  dramaDeskWinnerIds: string[];
  pulitzerWinnerIds: string[];
}

interface OlivierAwards {
  wins?: string[];
  nominations?: number;
  nominatedFor?: string[];
}

export function getAwardWinnerSets(): AwardWinnerSets {
  const tonyWinnerIds: string[] = [];
  const tonyNomineeIds: string[] = [];
  const olivierWinnerIds: string[] = [];
  const olivierNomineeIds: string[] = [];
  const dramaDeskWinnerIds: string[] = [];
  const pulitzerWinnerIds: string[] = [];

  for (const [showId, showAwards] of Object.entries(awards.shows)) {
    if (showAwards.tony) {
      const wins = showAwards.tony.wins?.length ?? 0;
      const noms = showAwards.tony.nominations ?? 0;
      if (wins > 0) tonyWinnerIds.push(showId);
      if (wins > 0 || noms > 0) tonyNomineeIds.push(showId);
    }
    const olivier = (showAwards as ShowAwards & { olivier?: OlivierAwards }).olivier;
    if (olivier) {
      const wins = olivier.wins?.length ?? 0;
      const noms = olivier.nominations ?? 0;
      if (wins > 0) olivierWinnerIds.push(showId);
      if (wins > 0 || noms > 0) olivierNomineeIds.push(showId);
    }
    if (showAwards.dramadesk?.wins?.length) dramaDeskWinnerIds.push(showId);
    // Only count actual Pulitzer winners — finalists go in `pulitzer.finalist`,
    // not `pulitzer.wins`. The legacy {year, category} shape always meant a win
    // and is migrated to wins:["Drama"] by enrich-awards-with-precursors.js.
    if (showAwards.pulitzer?.wins?.includes('Drama')) pulitzerWinnerIds.push(showId);
  }

  return {
    tonyWinnerIds,
    tonyNomineeIds,
    olivierWinnerIds,
    olivierNomineeIds,
    dramaDeskWinnerIds,
    pulitzerWinnerIds,
  };
}
