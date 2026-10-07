// Pure decision logic for canon (Tony winner) poster-art sourcing.
//
// A closed show whose title collides with a newer, currently-running
// production (e.g. a Broadway original vs. a regional/West End/revival
// listed under TodayTix) must not have its art auto-sourced from TodayTix —
// TodayTix returns art for whichever production is CURRENTLY live under that
// title, not the historical one we're trying to illustrate (BRO-119: the
// 2008 "In the Heights" OBC entry picked up CenterREP's regional poster this
// way). Extracted from scripts/fetch-show-images-auto.js's processOneShow
// guard so it can be unit tested without the network/API-key dependencies of
// the full fetch pipeline.
'use strict';

/**
 * The other show in `allShows` that made `show` unsafe to auto-source from
 * TodayTix — closed, shares `show`'s title (allowing punctuation-separated
 * variants like "The Tempest - Globe"), and opened later — or `null` if none
 * exists. When truthy, TodayTix sourcing must be skipped in favor of
 * production-specific sources (IBDB, ShowScore, Google Images, Playbill).
 *
 * @param {{id: string, title: string, status: string, openingDate?: string|null}} show
 * @param {Array<{id: string, title: string, openingDate?: string|null}>} allShows
 * @returns {{id: string, title: string, openingDate?: string|null}|null}
 */
function findNewerSameTitleProduction(show, allShows) {
  if (show.status !== 'closed') return null;

  const baseTitle = show.title.toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').trim();
  const showYear = show.openingDate ? new Date(show.openingDate).getFullYear() : 0;

  return allShows.find((s) => {
    if (s.id === show.id) return false;
    const sBase = s.title.toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').trim();
    // Exact match OR the full base title (2+ words) appears separated by punctuation (- : , !)
    // Catches "The Tempest - Globe", "Encores! The Wild Party", "Doubt: A Parable"
    // but NOT short titles like "Big" → "Big Fish" (space-only, no punct) or single words
    const escaped = baseTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasMultipleWords = baseTitle.includes(' ');
    const isVariant = hasMultipleWords &&
      new RegExp(`(^${escaped}\\s*[-:,]|[-:!]\\s*${escaped}$)`).test(sBase);
    if (sBase !== baseTitle && !isVariant) return false;
    const sYear = s.openingDate ? new Date(s.openingDate).getFullYear() : 0;
    return sYear > showYear;
  }) ?? null;
}

module.exports = { findNewerSameTitleProduction };
