import { TIER_WEIGHTS, MIN_REVIEWS_FOR_SCORE } from '@/config/scoring';
import { getTierKey, type TierKey } from '@/config/score-buckets';
import type { Outlet, Product, Review } from './data-types';

export interface ScoredReview extends Review {
  outlet: Outlet;
  weight: number;
}

export interface ComputedProduct extends Product {
  reviews: ScoredReview[];
  reviewCount: number;
  /** Reviews whose outlet published a score (the rest are scored from text). */
  ratedCount: number;
  /** Tier-weighted mean of review scores (unrounded; round once for display), null below MIN_REVIEWS_FOR_SCORE. */
  criticScore: number | null;
  breakdown: Record<TierKey, number>;
  latestReviewDate: string | null;
}

/** Tier-weighted average, same formula as Broadway Scorecard's compute-critic-score. */
export function computeCriticScore(reviews: ScoredReview[]): number | null {
  if (reviews.length < MIN_REVIEWS_FOR_SCORE) return null;
  let num = 0;
  let den = 0;
  for (const r of reviews) {
    num += r.score * r.weight;
    den += r.weight;
  }
  return den === 0 ? null : num / den;
}

export function computeProduct(product: Product, allReviews: Review[], outlets: Record<string, Outlet>): ComputedProduct {
  const reviews: ScoredReview[] = allReviews
    .filter((r) => r.productId === product.id)
    .map((r) => {
      const outlet = outlets[r.outletId];
      if (!outlet) throw new Error(`Unknown outlet "${r.outletId}" on a ${product.id} review`);
      return { ...r, outlet, weight: TIER_WEIGHTS[outlet.tier] };
    })
    .sort((a, b) => b.score - a.score || a.outlet.tier - b.outlet.tier);

  const breakdown: Record<TierKey, number> = { gold: 0, recommended: 0, worthIt: 0, mixed: 0, miss: 0 };
  for (const r of reviews) breakdown[getTierKey(r.score)]++;
  const latestReviewDate = reviews.reduce<string | null>((max, r) => (!max || r.date > max ? r.date : max), null);

  return {
    ...product,
    reviews,
    reviewCount: reviews.length,
    ratedCount: reviews.filter((r) => r.scoreSource === 'rating').length,
    criticScore: computeCriticScore(reviews),
    breakdown,
    latestReviewDate,
  };
}
