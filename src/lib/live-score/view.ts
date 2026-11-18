// BRO-7803: the score-region view model. One function builds every number and
// flag the show page's score area needs (hero, sticky header, breakdown bar,
// arrival copy, Critics' Take fallback). The page renders it as the static
// default; the live-score publisher serialises the same object, so the overlay
// can never disagree with the static page about the gate.
import type { ComputedShow } from '../engine';
import { computeShowTBD } from '../show-score-tbd';
import { reviewsRemainingForScore } from '../../config/score-buckets';
import { scoreGateArg } from '../../config/scoring';
import { noCriticReviewsExpected } from '../review-expectation';
import { getReviewArrival } from '../data-review-arrival';
import { getCriticsTakeDisplayMode } from '../../../scripts/lib/critics-take-display';

export type CriticsTakeMode = 'consensus' | 'coming-soon' | 'synopsis' | 'none';

export interface ScoreRegionView {
  score: number | null;
  reviewCount: number;
  tier1Count: number;
  tier2Count: number;
  showTBD: boolean;
  reviewsRemaining: number;
  noReviewsExpected: boolean;
  criticsTakeMode: CriticsTakeMode;
  /** ArrivalView from getReviewArrival (serialisable), or null. */
  reviewArrival: unknown;
}

export interface BreakdownReview { reviewScore: number | null | undefined; verdict?: string | null }

type ViewShow = Pick<ComputedShow, 'id' | 'category' | 'status' | 'criticScore' | 'scorePublicSince' | 'cov' | 'coverageAcked' | 'openingDate' | 'type' | 'synopsis'> & { [k: string]: unknown };

export function buildScoreRegionView(show: ViewShow, hasConsensus: boolean, now?: number): ScoreRegionView {
  const reviewCount = show.criticScore?.reviewCount || 0;
  const tier1Count = show.criticScore?.tier1Count || 0;
  const tier2Count = show.criticScore?.tier2Count || 0;
  const showTBD = computeShowTBD(show, now);
  const reviewsRemaining = showTBD && show.status !== 'previews' && show.status !== 'upcoming'
    ? reviewsRemainingForScore(reviewCount, show.category, tier1Count + tier2Count, scoreGateArg(show.id))
    : 0;
  return {
    score: show.criticScore?.score ?? null,
    reviewCount,
    tier1Count,
    tier2Count,
    showTBD,
    reviewsRemaining,
    noReviewsExpected: noCriticReviewsExpected(show as never, reviewCount),
    criticsTakeMode: getCriticsTakeDisplayMode(hasConsensus, !!show.criticScore, reviewCount, !!show.synopsis) as CriticsTakeMode,
    reviewArrival: getReviewArrival(show as never, reviewCount, !showTBD),
  };
}

export function breakdownReviews(show: Pick<ComputedShow, 'criticScore'>): BreakdownReview[] {
  return (show.criticScore?.reviews ?? []).map((r) => ({ reviewScore: r.reviewScore, verdict: r.verdict }));
}
