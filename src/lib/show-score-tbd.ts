// The show page's "Awaiting Reviews" decision for surfaces that render ONE
// show's score away from the page: the OG share card, the /embed widget and
// the /api/badge SVG (BRO-5811). Each used to re-derive TBD from the review
// count alone, so a show the page held at TBD under the coverage floor
// (scripts/lib/coverage-floor.js) still showed its score in the share card,
// embed and badge. Same inputs and order as page.tsx generateMetadata.
import type { ComputedShow } from './engine';
import { hasEnoughReviews, applyCoverageFloor } from '../config/score-buckets';
import { scoreGateArg } from '../config/scoring';

type ShowTbdFields = Pick<ComputedShow, 'id' | 'category' | 'status' | 'criticScore' | 'scorePublicSince' | 'cov' | 'coverageAcked'>;

/**
 * The show page's own TBD verdict (min-review gate, previews/upcoming, then the
 * coverage floor / BRO-7750 score exception). The page used to repeat this
 * block four times; BRO-7803 makes the page, the live-score publisher and the
 * overlay all call this one function.
 */
export function computeShowTBD(show: ShowTbdFields, now?: number): boolean {
  const cs = show.criticScore;
  const reviewCountTBD = !hasEnoughReviews(
    cs?.reviewCount ?? 0,
    show.category,
    (cs?.tier1Count ?? 0) + (cs?.tier2Count ?? 0),
    scoreGateArg(show.id),
  ) || show.status === 'previews' || show.status === 'upcoming';
  return applyCoverageFloor(reviewCountTBD, {
    scorePublicSince: show.scorePublicSince,
    coverageState: show.cov?.state,
    coverageAcked: show.coverageAcked,
    now,
  });
}

export function isShowScoreTBD(show: ShowTbdFields, now?: number): boolean {
  if (show.criticScore?.score == null) return true;
  return computeShowTBD(show, now);
}
