'use strict';
/**
 * Which production a fetched TodayTix show page is about (BRO-4851).
 *
 * TodayTix recycles numeric show IDs, so a stored ID can serve a different
 * show's page; that is why auto-fix-show-data.js sends every TodayTix synopsis
 * through the LLM wrong-show verifier. The verifier rejects any record too
 * sparse to confirm, which is every West End historical row (no cast or
 * creative team yet), so correct pages were thrown away (12 of 12 in run
 * 37802546159, e.g. The Shitheads at the Royal Court).
 *
 * The page carries its own identity in __NEXT_DATA__ props.pageProps.product
 * (id, displayName, venue.name, startingDate, closingDate). Only that object is
 * read: a recursive search could hit a related-shows carousel and vouch for a
 * recycled page. A page whose id, title, venue and dates all agree with the
 * record is this production.
 *
 * Pure, no I/O (CLAUDE.md §15); scripts/lib/todaytix-page-identity.test.mjs.
 */

const { normalizeTitle } = require('./title-normalization');
const { venuesMatch } = require('./image-source-match');

/** @returns {{id: string, title: string, venue: string|null, start: string|null, end: string|null}|null} */
function extractTodaytixPageIdentity(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''));
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const p = data && data.props && data.props.pageProps && data.props.pageProps.product;
  if (!p || p.id == null || !p.displayName) return null;
  return {
    id: String(p.id),
    title: String(p.displayName),
    venue: (p.venue && p.venue.name) || null,
    start: p.startingDate || null,
    end: p.closingDate || null,
  };
}

/**
 * True only when the page is this production: same TodayTix id as the one we
 * asked for, same title, same venue, and (when both sides carry dates) runs
 * that overlap. Same title + venue + overlapping dates still allows a page for
 * a returning run of the same staging; its plot is the same, so for synopsis
 * and creative team that is acceptable.
 */
function todaytixPageMatchesShow(identity, show, expectedId) {
  if (!identity || !show) return false;
  if (expectedId == null || identity.id !== String(expectedId)) return false;
  // Exact after normalization: titlesMatch's suffix stripping treats
  // "Shitheads II" as "The Shitheads", too loose to vouch for a page.
  if (normalizeTitle(identity.title) !== normalizeTitle(show.title)) return false;
  if (!identity.venue || !venuesMatch(identity.venue, show.venue)) return false;
  const showStart = show.previewsStartDate || show.openingDate || null;
  const showEnd = show.closingDate || null;
  if (identity.start && showEnd && identity.start > showEnd) return false;
  if (identity.end && showStart && identity.end < showStart) return false;
  return true;
}

module.exports = { extractTodaytixPageIdentity, todaytixPageMatchesShow };
