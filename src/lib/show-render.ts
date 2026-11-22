// BRO-8056 phase 1b-iii: the one place a show page gets ITS show's data.
//
// The page body, generateMetadata, JSON-LD and reviews.json all read the show,
// its critic consensus and its audience buzz from getShowForRender(), never
// from data-core / data-consensus / data-audience directly (eslint
// no-restricted-imports under src/app/show/** and src/components/show-page/**
// enforces it). Today it returns the build's values (rev 'base'); the
// show-refresh reader (phase 2) swaps in a published slice here, so every
// surface of the page changes together or not at all.
//
// Lookups of OTHER shows (related shows, tour parent, transfers) stay on
// data-core: they are not this show's data.
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
