// The show page's "Awaiting Reviews" decision for surfaces that render ONE
// show's score away from the page: the OG share card, the /embed widget and
// the /api/badge SVG (BRO-5811). Each used to re-derive TBD from the review
// count alone, so a show the page held at TBD under the coverage floor
// (scripts/lib/coverage-floor.js) still showed its score in the share card,
// embed and badge. Same inputs and order as page.tsx generateMetadata.
import type { ComputedShow } from './engine';
import { hasEnoughReviews, applyCoverageFloor } from '../config/score-buckets';
import { CURATED_HISTORICAL_SHOWS } from '../config/scoring';

type ShowTbdFields = Pick<ComputedShow, 'id' | 'category' | 'status' | 'criticScore' | 'scorePublicSince' | 'cov' | 'coverageAcked'>;

export function isShowScoreTBD(show: ShowTbdFields, now?: number): boolean {
  const cs = show.criticScore;
  if (cs?.score == null) return true;
  const reviewCountTBD = !hasEnoughReviews(
    cs.reviewCount ?? 0,
    show.category,
    (cs.tier1Count ?? 0) + (cs.tier2Count ?? 0),
    CURATED_HISTORICAL_SHOWS.has(show.id),
  ) || show.status === 'previews' || show.status === 'upcoming';
  return applyCoverageFloor(reviewCountTBD, {
    scorePublicSince: show.scorePublicSince,
    coverageState: show.cov?.state,
    coverageAcked: show.coverageAcked,
    now,
  });
}
