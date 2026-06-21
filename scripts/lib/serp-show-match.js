'use strict';

/**
 * serp-show-match.js — decide whether a SERP result is about a given show.
 *
 * Extracted from discover-opening-night-reviews.js so it can be unit-tested
 * against real failing headlines (CLAUDE.md rule 15). The discovery script
 * requires this module rather than holding its own copy.
 *
 * The matcher builds a set of title variants from the show title and checks
 * the result headline (word-boundary) and URL slug (delimiter-boundary).
 */

/**
 * @param {string} resultTitle  SERP result headline
 * @param {string} resultUrl    SERP result URL
 * @param {string} showTitle    canonical show title from shows.json
 * @returns {boolean}
 */
function serpResultMentionsShow(resultTitle, resultUrl, showTitle) {
  const title = (resultTitle || '').toLowerCase();
  const url = (resultUrl || '').toLowerCase();

  // Build list of title variants to check
  const variants = [];
  const mainTitle = (showTitle || '').replace(/^The\s+/i, '').trim();
  if (mainTitle.length >= 2) variants.push(mainTitle.toLowerCase());

  // Strip known series/season prefixes (e.g. "Encores!", "Encores! Off-Center").
  // Critics title these by the work, not the series — "La Cage aux Folles at
  // Encores!" never contains the contiguous phrase "Encores! La Cage aux Folles",
  // so the full-title match below would reject every legit Encores review.
  // Restricted to an explicit prefix list so titles whose own name contains "!"
  // (Oklahoma!, Moulin Rouge! The Musical) are never truncated to a generic core.
  const SERIES_PREFIX = /^Encores!(?:\s+Off-Center)?\s+/i;
  if (SERIES_PREFIX.test(showTitle || '')) {
    const core = showTitle.replace(SERIES_PREFIX, '').replace(/^The\s+/i, '').trim();
    if (core.length >= 2) variants.push(core.toLowerCase());
  }

  // Primary title before : or - (e.g., "CATS: The Jellicle Ball" → "CATS")
  if ((showTitle || '').includes(':')) {
    const pre = showTitle.split(':')[0].replace(/^The\s+/i, '').trim();
    if (pre.length >= 2) variants.push(pre.toLowerCase());
  }
  if ((showTitle || '').includes(' - ')) {
    const pre = showTitle.split(' - ')[0].replace(/^The\s+/i, '').trim();
    if (pre.length >= 2) variants.push(pre.toLowerCase());
  }

  // Check title with word boundaries
  for (const v of variants) {
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(title)) return true;
  }

  // Check URL slug with boundary matching (delimiters: / and -)
  // Prevents "bug" matching "debugging", "six" matching "sixth"
  for (const v of variants) {
    const slug = v.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (slug.length >= 3) {
      const slugEscaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:^|[/\\-])${slugEscaped}(?:$|[/\\-])`, 'i').test(url)) return true;
    }
  }

  return false;
}

module.exports = { serpResultMentionsShow };
