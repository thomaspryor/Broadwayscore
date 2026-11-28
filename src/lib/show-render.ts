// BRO-8056 phase 1b-iii: the one place a show page gets ITS show's data.
//
// The page body, generateMetadata, JSON-LD and reviews.json read the show,
// its critic consensus and its audience buzz from getShowForRender(), never
// from data-core / data-consensus / data-audience directly. eslint
// no-restricted-imports under src/app/show/** and src/components/show-page/**
// blocks the direct getters (getShowBySlug, getCriticConsensus,
// getAudienceBuzz*), at any relative depth and through the @/lib/data barrel. Today it returns the build's values (rev 'base'); the
// show-refresh reader (phase 2) swaps in a published slice here, so every
// surface of the page changes together or not at all.
//
// Lookups of OTHER shows (related shows, tour parent, transfers) stay on
// data-core: they are not this show's data.
//
// Known gaps the lint rule cannot see, to close in phase 2 before a slice can
// differ from the build: getShowRanks(show.id) reads every show's audience
// buzz to rank this one, getShowLastUpdated(show.id) reads the build's
// timestamps, and page.tsx's audience platform links call
// getAudiencePlatformUrl (module map); switch them to
// audiencePlatformUrlFrom(k, id, render.audienceBuzz), which matches it for
// all 3444 shows with buzz today (544 links, 0 differences). Both still reflect the build while the rest of the page could
// reflect a slice; phase 2 must take them from the slice (or accept and
// document the lag) before the reader is switched on.
import { cache } from 'react';
// '@/lib/...' specifiers, not './...': tests stub '@/lib/data-core' by that exact
// id (Module._load in show-og-poster-layout / live-in-hd tests), and a relative
// import would bypass the stub.
import { getShowBySlug, withVerifiedVenueAddress, type ComputedShow } from '@/lib/data-core';
import { getCriticConsensus, normalizeCriticConsensus } from '@/lib/data-consensus';
import { getAudienceBuzz, normalizeAudienceBuzz } from '@/lib/data-audience';
import type { AudienceBuzzData, CriticConsensus } from '@/lib/data-types';
import { computeOneShow } from '@/lib/compute-one-show';
import { isShowScoreTBD } from '@/lib/show-score-tbd';
import { versionedImagePath } from '@/lib/versioned-image-path';
import type { RawShow, RawReview, RawAudience, RawBuzzThread } from '@/lib/engine';
import { REV_BASE, REV_BASE_ERROR, showRefreshEnabled, type PublishedSlice, type RefreshDecision } from '@/lib/show-refresh-core';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const { coverageInputsFromSlice } = require('../../scripts/lib/show-refresh/slice') as {
  coverageInputsFromSlice(slice: PublishedSlice): Parameters<typeof computeOneShow>[2]['coverageFloorInputs'];
};

/** Marker value of a render that used the build's data (no published slice). */
export const BASE_REV = REV_BASE;
export { REV_BASE_ERROR };

export interface ShowRender {
  show: ComputedShow;
  consensus: CriticConsensus | undefined;
  audienceBuzz: AudienceBuzzData | undefined;
  /**
   * The page's refresh marker (plan row 10, R7): 'base' (the build's data on
   * purpose), 'base-error' (the build's data because the store or slice could
   * not be trusted; the publisher re-queues it), or the slice hash rendered.
   */
  rev: string;
}

function baselineRender(slug: string, rev: string = REV_BASE): ShowRender | null {
  const show = getShowBySlug(slug);
  if (!show) return null;
  return {
    show,
    consensus: getCriticConsensus(show.id),
    audienceBuzz: getAudienceBuzz(show.id),
    rev,
  };
}

/**
 * The render for a published slice, computed exactly as the build computes a
 * show (computeOneShow), with the build's instant as the clock (plan row 6) so
 * an unchanged slice renders like the build. Null => use the build: the show
 * would be TBD or score-less (held shows are never refreshed).
 */
export function renderFromSlice(slice: PublishedSlice, buildInstant: number, rev: string): ShowRender | null {
  const show = withVerifiedVenueAddress(computeOneShow(slice.row as unknown as RawShow, slice.reviews as RawReview[], {
    blogReviews: slice.blogReviews as RawReview[],
    audience: slice.audience as RawAudience[],
    buzz: slice.buzz as RawBuzzThread[],
    coverageFloorInputs: coverageInputsFromSlice(slice),
    versionImage: versionedImagePath,
    now: buildInstant,
  }));
  // Stricter than the build's held rule (computeShowTBD): a slice that yields no
  // score at all also renders the build.
  if (isShowScoreTBD(show, buildInstant)) return null;
  const { category, status, closingDate } = slice.row as unknown as { category: string; status: string; closingDate?: string | null };
  return {
    show,
    consensus: normalizeCriticConsensus(slice.consensus as CriticConsensus | null),
    audienceBuzz: slice.audienceBuzz
      ? normalizeAudienceBuzz(slice.audienceBuzz as AudienceBuzzData, { category, status, closingDate } as Parameters<typeof normalizeAudienceBuzz>[1])
      : undefined,
    rev,
  };
}

/** Pure: a reader decision -> this request's render. Exported for tests. */
export function renderForDecision(slug: string, decision: RefreshDecision, buildInstant: number | null): ShowRender | null {
  if (!('slice' in decision) || buildInstant == null) return baselineRender(slug, decision.rev);
  try {
    return renderFromSlice(decision.slice, buildInstant, decision.rev) ?? baselineRender(slug, REV_BASE);
  } catch {
    return baselineRender(slug, REV_BASE_ERROR);
  }
}

/**
 * This show's data for one render. Cached per request, so metadata, body and
 * JSON-LD of the same request can never see two different versions. With the
 * reader off (SHOW_REFRESH_READER unset) it resolves to the build's data
 * without touching the store.
 */
export const getShowForRender = cache(async (slug: string): Promise<ShowRender | null> => {
  // Loaded lazily: show-refresh.ts is server-only and reads the manifest.
  if (!showRefreshEnabled()) return baselineRender(slug);
  try {
    const { readShowRefresh, buildManifest } = await import('@/lib/show-refresh');
    const decision = await readShowRefresh(slug);
    return renderForDecision(slug, decision, buildManifest()?.buildInstant ?? null);
  } catch {
    // Reader module failed to load or threw: never 5xx, render the build.
    return baselineRender(slug, REV_BASE_ERROR);
  }
});
