/**
 * National-tour listing rules (BRO-4931). Pure: no data imports, so
 * browse-pages.ts, scripts and tests can use them. data-core.ts adds the
 * schedule-aware wrappers (getTourBrowseShows, isTourIndexable).
 *
 * Three separate questions, three separate rules:
 *   scored     enough critic reviews for a CriticScore (isTourScored)
 *   browsable  on the tours page: scored, or still running with stops ahead
 *   indexable  search engines may index the show page: the same rule as
 *              browsable, so a page is never indexed yet missing from the tours
 *              page (or the reverse). The schedule is the page's own content,
 *              so an unscored tour whose last stop has ended has nothing left.
 * A tour is "listed" on score surfaces (home shelf, city pages) only when scored.
 */

import { getMarketMinReviews } from './market-utils';
import { applyCoverageFloor } from '../config/score-buckets';
import type { ComputedShow } from './engine';

type TourScoreFields = Pick<ComputedShow, 'category' | 'criticScore'>;
type TourStatusFields = TourScoreFields & Pick<ComputedShow, 'status'>;

/**
 * True when a tour has enough critic reviews for a score. Same rule as the
 * score badge (ScoreBadge.tsx): the market minimum, +2 when no T1/T2 review.
 * Non-tour shows are always "scored" for this purpose.
 */
export function isTourScored(show: TourScoreFields): boolean {
  if (show.category !== 'tour') return true;
  const cs = show.criticScore;
  const top = (cs?.tier1Count ?? 0) + (cs?.tier2Count ?? 0);
  const min = getMarketMinReviews('tour') + (top === 0 ? 2 : 0);
  return (cs?.reviewCount ?? 0) >= min;
}

/**
 * A tour that is on the road (open or in previews), as opposed to announced
 * (upcoming) or finished. Only a live tour with no score yet says "Reviews
 * coming in"; an upcoming one keeps the ordinary "awaiting reviews" copy.
 */
export function isLiveTour(show: Pick<ComputedShow, 'category' | 'status'>): boolean {
  return show.category === 'tour' && (show.status === 'open' || show.status === 'previews');
}

/**
 * True when the show page shows "TBD" instead of this tour's score: the page's
 * own `showTBD` rule (src/app/show/[slug]/page.tsx), so structured data can
 * never claim a rating the page hides. Too few reviews (isTourScored), in
 * previews or upcoming, or held back by the coverage floor. A score that has
 * been public for 24h+ stays shown (applyCoverageFloor rule 2).
 */
export function isTourScoreHidden(
  show: TourStatusFields & Pick<ComputedShow, 'scorePublicSince' | 'cov' | 'coverageAcked'>,
): boolean {
  return applyCoverageFloor(
    !isTourScored(show) || show.status === 'previews' || show.status === 'upcoming',
    { scorePublicSince: show.scorePublicSince, coverageState: show.cov?.state, coverageAcked: show.coverageAcked },
  );
}

/** The tours page headings, in display order. */
export const TOUR_SECTIONS = ['On the road now', 'Reviews coming in', 'Coming soon', 'Closed tours'] as const;
export type TourSection = typeof TOUR_SECTIONS[number];

/**
 * Which tours-page section a tour belongs to. Mutually exclusive and ordered
 * by TOUR_SECTIONS so a sort on tourSectionRank keeps each heading in one run.
 */
export function getTourSection(show: Pick<ComputedShow, 'status' | 'criticScore' | 'category'>): TourSection {
  if (show.status === 'closed') return 'Closed tours';
  if (show.status === 'upcoming') return 'Coming soon';
  return isTourScored(show) ? 'On the road now' : 'Reviews coming in';
}

export function tourSectionRank(show: Pick<ComputedShow, 'status' | 'criticScore' | 'category'>): number {
  return TOUR_SECTIONS.indexOf(getTourSection(show));
}

/**
 * On the tours page: scored tours (any status) plus tours that are not closed
 * and still have engagements to come. `hasFutureStops` is the caller's
 * schedule lookup, kept out of here so this stays pure.
 */
export function isTourBrowsable(show: TourStatusFields, hasFutureStops: boolean): boolean {
  if (show.category !== 'tour') return false;
  if (isTourScored(show)) return true;
  return show.status !== 'closed' && hasFutureStops;
}

/**
 * Whether a tour's show page is indexed and in the sitemap / search. Same rule
 * as isTourBrowsable: a scored tour always; an unscored tour only while it is
 * not closed and still has a stop ahead (`hasFutureStops`). A closed tour, or
 * one whose engagements have all ended, stays noindex and off the tours page.
 */
export function isTourIndexable(show: TourStatusFields, hasFutureStops: boolean): boolean {
  if (show.category !== 'tour') return true;
  return isTourBrowsable(show, hasFutureStops);
}
