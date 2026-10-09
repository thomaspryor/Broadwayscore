/**
 * Display helpers for national-tour pages (category 'tour', BRO-4211).
 *
 * A tour entry has no single venue ("North American Tour") and usually no
 * openingDate, so the show page's usual date line is empty. The span of its
 * reviews' publish years is the honest stand-in: "reviewed 2022–2025".
 */

import { getReviewPublishYears } from './show-date-line';

/** "2022–2025", "2024", or null when no review carries a readable year. */
export function getTourReviewYears(reviews: ReadonlyArray<{ publishDate?: string | null }> | undefined): string | null {
  const years = getReviewPublishYears(reviews);
  if (years.length === 0) return null;
  const lo = Math.min(...years);
  const hi = Math.max(...years);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

/**
 * How a tour's trust line names the production it tours, lower-cased where it
 * reads as a common noun ("the regional run", "See the regional production").
 * Mirrors TOUR_PARENT_LABELS in scripts/lib/tour-family.js, which the page
 * audit checks the rendered link against (tour-display.test.ts keeps them equal).
 * Not getMarketLabel(): that is a heading label, so "the Regional run" read wrong.
 */
export const TOUR_PARENT_LABELS: Record<string, string> = {
  broadway: 'Broadway',
  'off-broadway': 'Off-Broadway',
  regional: 'regional',
  'west-end': 'West End',
  'off-west-end': 'Off-West End',
};

/** In-sentence name of a tour's parent production. A missing category is Broadway. */
export function getTourParentLabel(category?: string | null): string {
  return TOUR_PARENT_LABELS[category || 'broadway'] ?? 'Broadway';
}

/**
 * The clause a parent's "On tour" line uses once at least one of its tours has
 * a score, agreeing in number with the tours it links ("the national tour has
 * its own critic score" for one, "one of the national tours has ..." when a
 * scored tour sits beside an upcoming one).
 */
export function describeTourScores(scored: number, total: number): string {
  if (total <= 1) return 'the national tour has its own critic score';
  if (scored >= total) return 'the national tours have their own critic scores';
  if (scored === 1) return 'one of the national tours has its own critic score';
  return `${scored} of the national tours have their own critic scores`;
}
