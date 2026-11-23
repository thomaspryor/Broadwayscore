/**
 * BRO-8056 phase 2 (plan G1): the prod-data-parity row a refreshed show page
 * must render, computed from its published slice the way the page computes it
 * (computeOneShow with the build's instant, src/lib/show-render.ts
 * renderFromSlice). prod-data-parity.js uses it for a page whose refresh marker
 * is a slice hash; marker 'base' keeps the prebuild snapshot row.
 *
 * Row shape = prod-data-parity buildSnapshot's sample row: { score, reviewCount },
 * score null below the display gate (slim `cs` null), the scored review count either way
 * (snapshot reads slim scoreResult.rc, which is not gated).
 */
import { computeOneShow } from '../../../src/lib/compute-one-show';
import { hasEnoughReviews } from '../../../src/config/score-buckets';
import { scoreGateArg } from '../../../src/config/scoring';
import type { RawShow, RawReview, RawAudience, RawBuzzThread } from '../../../src/lib/engine';

/* eslint-disable @typescript-eslint/no-require-imports */
const { coverageInputsFromSlice } = require('./slice');
/* eslint-enable @typescript-eslint/no-require-imports */

export interface ParityRow { score: number | null; reviewCount: number }

export function expectedParityRow(
  slice: { row: unknown; reviews: unknown[]; blogReviews: unknown[]; audience: unknown[]; buzz: unknown[] },
  ctx: { buildInstant: number; versionImage?: <T extends string | null | undefined>(p: T) => T },
): ParityRow {
  const show = computeOneShow(slice.row as RawShow, slice.reviews as RawReview[], {
    blogReviews: slice.blogReviews as RawReview[],
    audience: slice.audience as RawAudience[],
    buzz: slice.buzz as RawBuzzThread[],
    coverageFloorInputs: coverageInputsFromSlice(slice),
    versionImage: ctx.versionImage ?? (<T,>(p: T) => p),
    now: ctx.buildInstant,
  });
  const cs = show.criticScore;
  if (!cs || cs.score == null) return { score: null, reviewCount: 0 };
  const enough = hasEnoughReviews(cs.reviewCount, show.category, (cs.tier1Count ?? 0) + (cs.tier2Count ?? 0), scoreGateArg(show.id));
  return { score: enough ? Math.round(cs.score) : null, reviewCount: cs.reviewCount };
}
