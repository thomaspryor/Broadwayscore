import awardsData from '../../data/awards.json';
import { computeAwardScoreForEntry, type AwardsShowEntry, type Market, type ScoreResult } from './awards-scoring';

/**
 * Site award score for a show, read from data/awards.json. Server and
 * scripts only: the JSON is 1.4MB, so browser code gets a precomputed
 * ScoreResult as a prop instead (see getAwardsSummary in data-awards.ts).
 */
export function computeSiteAwardScore(showId: string, market: Market = 'broadway'): ScoreResult {
  const shows = (awardsData as unknown as { shows: Record<string, AwardsShowEntry> }).shows;
  return computeAwardScoreForEntry(shows[showId], market);
}
