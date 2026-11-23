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
import { getShowBySlug, type ComputedShow } from './data-core';
import { getCriticConsensus } from './data-consensus';
import { getAudienceBuzz } from './data-audience';
import type { AudienceBuzzData, CriticConsensus } from './data-types';

/** Marker value of a render that used the build's data (no published slice). */
export const BASE_REV = 'base';

export interface ShowRender {
  show: ComputedShow;
  consensus: CriticConsensus | undefined;
  audienceBuzz: AudienceBuzzData | undefined;
  /** BASE_REV, or the published slice hash the render used (phase 2). */
  rev: string;
}

function baselineRender(slug: string): ShowRender | null {
  const show = getShowBySlug(slug);
  if (!show) return null;
  return {
    show,
    consensus: getCriticConsensus(show.id),
    audienceBuzz: getAudienceBuzz(show.id),
    rev: BASE_REV,
  };
}

/**
 * This show's data for one render. Cached per request, so metadata, body and
 * JSON-LD of the same request can never see two different versions.
 */
export const getShowForRender = cache((slug: string): ShowRender | null => baselineRender(slug));
