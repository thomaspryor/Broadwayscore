// Server-only: the card-shaped review rows ReviewsList renders (BRO-6278).
// Shared by the show page (first rows, inline) and /show/<slug>/reviews.json
// (the rest). Only fields ReviewsList reads, and no empty keys: each key or
// null costs bytes in the RSC payload.
import { getOutletSlugById, getCriticSlugByName } from '@/lib/data-reviews';
import { getOutletBadge } from '@/config/outlet-logos';
import { TOP_CRITICS } from '@/config/scoring';
import { getPriorRunLabel } from '../../scripts/lib/prior-run-label';
import { formatOriginalRating } from '@/lib/format-original-rating';
import { getTourSchedule } from '@/lib/data-tour-schedule';
import { stopForReview } from '@/lib/tour-schedule';
import type { ComputedShow } from '@/lib/data-types';
import type { ReviewListItem } from '@/components/ReviewsList';

/** Review rows rendered inline; the rest load from /show/<slug>/reviews.json. Equals ReviewsList's initialCount. */
export const REVIEWS_INLINE_COUNT = 5;

/** Drops undefined and null keys; ReviewsList treats absent and null alike. url keeps its null (it is part of the list key). */
function dropEmpty<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && (v !== null || k === 'url'))) as T;
}

export function getReviewListItems(show: ComputedShow): ReviewListItem[] {
  const tourStops = show.category === 'tour' ? getTourSchedule(show.id) : [];
  return (show.criticScore?.reviews ?? []).map(r => dropEmpty({
    outletId: r.outletId,
    outlet: r.outlet,
    outletSlug: getOutletSlugById(r.outletId) || undefined,
    outletBadge: getOutletBadge(r.outletId, r.outlet),
    criticName: r.criticName,
    criticSlug: r.criticName ? getCriticSlugByName(r.criticName) : null,
    url: r.url,
    publishDate: r.publishDate,
    tier: r.tier,
    reviewScore: r.reviewScore,
    designation: r.designation,
    quote: r.quote,
    summary: r.summary,
    pullQuote: r.pullQuote,
    originalRating: formatOriginalRating(r.originalRating) ?? undefined,
    priorRunLabel: show.priorRuns ? getPriorRunLabel(show.priorRuns, r.publishDate) : null,
    stopLabel: tourStops.length ? (stopForReview(tourStops, r.publishDate)?.city ?? null) : undefined,
    isTopCritic: !!(r.criticName && TOP_CRITICS.has(r.criticName)) || undefined,
  }));
}
