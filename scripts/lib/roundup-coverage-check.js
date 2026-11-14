/**
 * Cross-checks a hand-curated list of {title, venue} candidates (e.g. an
 * editorial roundup like a NYT "Off Broadway shows to see" feature) against
 * shows.json, reporting which candidates have no matching entry.
 *
 * BRO-155: the NYT's Aug 2026 off-Broadway roundup listed 15 shows and
 * shows.json had 6 — a discovery gap because these are tiny off-off-Broadway
 * productions with no BWW/Show Score/DTLI/Playbill footprint, so none of the
 * existing aggregator scrapers (which key off an outlet publishing a review
 * roundup with review links, not a curated editorial pick list) ever surface
 * them. This module is the reusable check: point it at ANY future editorial
 * list to find the gap before it's reported externally, rather than building
 * a one-off NYT scraper (NYT is paywalled and its feature format isn't
 * stable enough to parse reliably).
 *
 * Matching reuses the same primitives venue-date validation and dedup use —
 * normalizeTitle for fuzzy title equality, venuesMatch for venue aliasing —
 * so a candidate isn't reported missing just because of punctuation/casing
 * drift ("Brooklyn's Bridge" vs "Brooklyns Bridge") or a venue alias
 * ("Joe's Pub" vs "Joe's Pub at The Public Theatre").
 */

'use strict';

const { normalizeTitle } = require('./title-match');
const { venuesMatch } = require('./deduplication');

/**
 * @param {Array<{title: string, venue?: string}>} roundupEntries
 * @param {Array<{title: string, venue?: string}>} shows
 * @returns {Array<{title: string, venue?: string}>} entries from
 *   roundupEntries with no matching show
 */
function findMissingRoundupShows(roundupEntries, shows) {
  if (!Array.isArray(roundupEntries) || !Array.isArray(shows)) return [];

  return roundupEntries.filter((entry) => {
    const entryTitle = normalizeTitle(entry.title);
    if (!entryTitle) return false;

    return !shows.some((show) => {
      if (normalizeTitle(show.title) !== entryTitle) return false;
      // No venue on the candidate (or on the show) — title match alone
      // is enough to call it covered.
      if (!entry.venue || !show.venue) return true;
      return venuesMatch(entry.venue, show.venue);
    });
  });
}

module.exports = { findMissingRoundupShows };
