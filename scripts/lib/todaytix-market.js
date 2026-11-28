/**
 * todaytix-market.js — which TodayTix city a show lives in, and the URLs /
 * queries that follow from it (BRO-4326 / BRO-4401).
 *
 * fetch-show-images-auto.js's TodayTix page discovery was hard-wired to New
 * York: it searched /nyc/shows?q=, queried Google for `site:todaytix.com
 * "<title>" broadway nyc`, and REJECTED any SERP hit under /london/. For a
 * West End or Off-West End show that meant the best image source on the
 * whole chain could never match, and the show fell through to IBDB (a
 * Broadway-only database, so any hit is another production), Google Images
 * (mostly wrong-show rejects — see the Player / King Lear 2 logs of
 * 2026-09-29) and a Playbill search that requires "-broadway" in the URL.
 * Newly scored London shows therefore stayed imageless and tripped the
 * image-presence self-heal test on every run.
 *
 * The TodayTix REST lookup was already two-market (location=1 NYC,
 * location=2 London) — this makes the page-discovery path match it.
 *
 * Pure functions, no I/O (CLAUDE.md §15); scripts/lib/todaytix-market.test.mjs.
 */

'use strict';

const LONDON_MARKETS = new Set(['west-end', 'off-west-end']);

/**
 * 'london' for West End / Off-West End rows (by category first, then the
 * explicit market field), 'nyc' for everything else. Regional and tour shows
 * are 'nyc' here only because TodayTix has no page for them at all; the
 * fetcher routes those to venue sources before it reaches TodayTix.
 *
 * @param {{category?: string|null, market?: string|null}} show
 * @returns {'nyc'|'london'}
 */
function todaytixMarket(show) {
  const norm = (v) => String(v || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (LONDON_MARKETS.has(norm(show && show.category))) return 'london';
  if (LONDON_MARKETS.has(norm(show && show.market))) return 'london';
  return 'nyc';
}

/**
 * On-site search page for the show's market. (/nyc/shows?q= — the old
 * hard-coded path — is a 404 on the current site; /<city>/search?q= is the
 * live route for both cities.)
 *
 * @param {'nyc'|'london'} market
 * @param {string} cleanedTitle already passed through the fetcher's cleanSearchTitle()
 */
function todaytixSearchUrl(market, cleanedTitle) {
  return `https://www.todaytix.com/${market}/search?q=${encodeURIComponent(cleanedTitle)}`;
}

/**
 * Matches a show page link for the given market only — a London show must
 * not accept an /nyc/ page and vice versa (same-title productions in both
 * cities carry different art).
 *
 * @param {'nyc'|'london'} market
 * @returns {RegExp} groups: [1] numeric id, [2] slug
 */
function todaytixShowLinkRe(market) {
  return new RegExp(`todaytix\\.com\\/${market}\\/shows\\/(\\d+)-([a-z0-9-]+)|\\/${market}\\/shows\\/(\\d+)-([a-z0-9-]+)`, 'i');
}

/**
 * Extract {id, slug} of the first show link for `market` in some HTML or URL
 * text, or null.
 */
function extractTodaytixShowLink(text, market) {
  const m = String(text || '').match(todaytixShowLinkRe(market));
  if (!m) return null;
  const id = parseInt(m[1] || m[3], 10);
  const slug = m[2] || m[4];
  if (!Number.isFinite(id) || !slug) return null;
  return { id, slug };
}

/**
 * Google query for the show's TodayTix page. The market keyword is what
 * keeps a London title from resolving to the Broadway run of the same show.
 *
 * @param {'nyc'|'london'} market
 * @param {string} title raw show title
 */
function todaytixSerpQuery(market, title) {
  const where = market === 'london' ? 'london' : 'broadway nyc';
  return `site:todaytix.com "${title}" ${where}`;
}

/**
 * The show page URL to scrape for images.
 *
 * @param {'nyc'|'london'} market
 * @param {number|string} id
 * @param {string} slug
 */
function todaytixShowUrl(market, id, slug) {
  return `https://www.todaytix.com/${market}/shows/${id}-${slug}`;
}

module.exports = {
  LONDON_MARKETS,
  todaytixMarket,
  todaytixSearchUrl,
  todaytixShowLinkRe,
  extractTodaytixShowLink,
  todaytixSerpQuery,
  todaytixShowUrl,
};
