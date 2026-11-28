// BRO-8056 phase 1a: one show's computed record.
// getAllShows() (data-core.ts) maps every show through this. Show-refresh
// (later phases) calls it with one show's slice.
// Contract: rawReviews and deps.blogReviews must be THIS show's reviews only
// (checked below). Pass deps.registry and deps.now to make the result a pure
// function of its arguments (no file read, no clock; compute-one-show.test).
// coverage-floor-inputs is a server-only module (it imports fs) but
// coverageFloorOptsForShow itself reads none.
import {
  computeShowData,
  ComputedShow,
  RawShow,
  RawReview,
  RawAudience,
  RawBuzzThread,
} from './engine';
import { coverageFloorOptsForShow } from '../../scripts/lib/coverage-floor-inputs';
import { coverageHoldReleased } from '../../scripts/lib/coverage-floor';

export type CoverageFloorInputs = ReturnType<typeof import('../../scripts/lib/coverage-floor-inputs').readCoverageFloorInputs>;

export interface ComputeOneShowDeps {
  /** Blog reviews for this show (prebuild output), scored after its critic reviews. Required ([] if none) so a caller cannot silently drop them. */
  blogReviews: RawReview[];
  audience: RawAudience[];
  buzz: RawBuzzThread[];
  coverageFloorInputs: CoverageFloorInputs;
  /** Maps an image path to its versioned URL (versioned-image-path.ts). */
  versionImage: <T extends string | null | undefined>(imagePath: T) => T;
  /**
   * Clock (ms epoch) for market dates, status, review age, computedAt and the
   * coverage-hold ceiling; defaults to the real clock. Show-refresh passes the
   * build's instant so an overlay render matches the build.
   */
  now?: number;
  /** Outlet registry (outlets map); defaults to the cached data/outlet-registry.json read. */
  registry?: Record<string, unknown>;
}

export function computeOneShow(show: RawShow, rawReviews: RawReview[], deps: ComputeOneShowDeps): ComputedShow {
  for (const list of [rawReviews, deps.blogReviews]) {
    for (const r of list) {
      if (r.showId !== show.id) throw new Error(`computeOneShow(${show.id}): got a review for ${r.showId}; pass only this show's reviews`);
    }
  }
  const showReviews = deps.blogReviews.length
    ? [...rawReviews, ...deps.blogReviews]
    : rawReviews;
  const computed = computeShowData(show, showReviews, deps.audience, deps.buzz, { registry: deps.registry, now: deps.now });
  if (computed.images) {
    computed.images = {
      ...computed.images,
      thumbnail: deps.versionImage(computed.images.thumbnail),
      poster: deps.versionImage(computed.images.poster),
      hero: deps.versionImage(computed.images.hero),
    };
  }
  const cov = deps.coverageFloorInputs.covByShowId.get(show.id);
  if (cov) computed.cov = cov;
  // A stamp from before the show opened is dropped there (stale wrong-production blip).
  const floorOpts = coverageFloorOptsForShow(deps.coverageFloorInputs, show);
  if (floorOpts.scorePublicSince) computed.scorePublicSince = floorOpts.scorePublicSince;
  // BRO-7197: the coverage hold has a ceiling (8+ scored reviews, or 72h after opening). Folded in here, once per
  // show, so every applyCoverageFloor caller that reads show.coverageAcked gets it without passing the count.
  if (floorOpts.coverageAcked || coverageHoldReleased({
    scoredReviewCount: computed.criticScore?.reviewCount ?? 0,
    openingDate: show.openingDate,
    now: deps.now,
  })) computed.coverageAcked = true;
  return computed;
}
