// Server-only: the below-fold props that depend only on the show (BRO-6278).
// Served as /show/<slug>/below-fold.json (see that route) so they stay out of
// the page's inlined RSC payload; the below-fold chunk is not server-rendered,
// so nothing visible moves.
import { getShowAwards, getAwardsSummary } from '@/lib/data-awards';
import { getTonyNamesByCategory, getShowCastTonyMap } from '@/lib/data-tony-noms';
import { getShowSchedule, getShowShowtimeIds } from '@/lib/data-showtimes';
import { getCastChanges } from '@/lib/data-cast';
import { getShowCastFile } from '@/lib/data-cast-obc';
import { getActorSlugMap } from '@/lib/data-actors';
import { getVideoReviews } from '@/lib/data-video-reviews';
import { getComparisonsForShow } from '@/config/comparisons';
import { featureFlags } from '@/config/feature-flags';
import { isLondonMarket } from '@/lib/venue-classification';
import { foldVenueName } from '@/lib/venue-fold';
import { serializeShowForClient } from '@/lib/serialize-show';
import { getRelatedShowsOpen, getRelatedShowsClosed, getOtherProductions, getTheaterBySlug, slugify } from '@/lib/data-core';
import type { ComputedShow } from '@/lib/data-types';
import type { ShowBelowFoldDeferred } from '@/components/show-page/ShowPageBelowFold';

/**
 * Raw (unserialized) related-show lists. The page needs the raw objects for
 * its compact related row; the below-fold card needs them card-shaped.
 */
export function getRelatedShowLists(show: ComputedShow) {
  const openRaw = getRelatedShowsOpen(show);
  // A show already in "Open Shows You Might Like" (e.g. Oh, Mary! playing Off-Broadway)
  // must not reappear in "Closed" for its Broadway run, so drop closed recs whose title matches.
  const norm = (t: string) => t.toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').trim();
  const openTitles = new Set(openRaw.map(s => norm(s.title)));
  const closedRaw = (show.category !== 'west-end' && show.category !== 'off-west-end')
    ? getRelatedShowsClosed(show, 12).filter(s => !openTitles.has(norm(s.title))).slice(0, 6)
    : [];
  return { openRaw, closedRaw };
}

export function getShowBelowFoldDeferred(show: ComputedShow): ShowBelowFoldDeferred {
  const awards = getShowAwards(show.id);
  const castFile = getShowCastFile(show.id);
  // Pre-compute actor slug map for clickable cast names
  const castActorSlugs: Record<string, string> = {};
  if (featureFlags.castPages && castFile) {
    const allPersonIds = [
      ...(castFile.openingNightCast || []),
      ...(castFile.currentCast || []),
      ...(castFile.replacements || []),
    ].map(m => m.ibdbPersonId).filter((id): id is string => !!id);
    const slugMap = getActorSlugMap(allPersonIds);
    for (const [id, slug] of Array.from(slugMap.entries())) castActorSlugs[id] = slug;
  }
  // Theater scorecard lookup (Broadway only): regional/off-broadway/tour venues aren't Broadway houses.
  const theater = !isLondonMarket(show.category) && show.category !== 'off-broadway' && show.category !== 'regional' && show.category !== 'tour' && show.venue
    ? getTheaterBySlug(slugify(foldVenueName(show.venue)))
    : undefined;
  // Card-shape these before they cross the client boundary (card #419): the raw
  // objects carry every review of every related show.
  const { openRaw, closedRaw } = getRelatedShowLists(show);
  return {
    videoReviews: getVideoReviews(show.id),
    awards: awards ?? null,
    awardsSummary: awards ? getAwardsSummary(show.id, show.openingDate, show.category) : null,
    tonyNamesByCategory: getTonyNamesByCategory(show.id),
    showtimeIds: getShowShowtimeIds(show.id),
    showSchedule: getShowSchedule(show.id) ?? null,
    // Narrowed to the fields the two theater cards render; the full Theater carries every production ever staged (card #419).
    theater: theater && {
      name: theater.name,
      slug: theater.slug,
      venueScores: theater.venueScores,
      accessibility: theater.accessibility,
      externalLinks: theater.externalLinks,
      structuredTips: theater.structuredTips,
    },
    castChangesData: getCastChanges(show.id),
    castFile,
    castActorSlugs,
    castTonyMap: featureFlags.castPages ? getShowCastTonyMap(show.id) : {},
    otherProductions: getOtherProductions(show).map(s => serializeShowForClient(s)),
    relatedShowsOpen: openRaw.map(s => serializeShowForClient(s)),
    relatedShowsClosed: closedRaw.map(s => serializeShowForClient(s)),
    comparisons: getComparisonsForShow(show.slug),
  };
}
