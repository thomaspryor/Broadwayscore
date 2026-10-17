'use strict';

/**
 * Pure decision logic for scripts/validate-market-expansion.js (BRO-2507).
 *
 * Extracted (CLAUDE.md §15, BRO-31 pattern: mobile-shows-validator.js) so every
 * class the CI gate detects can be unit-tested from fixtures without the real
 * shows.json / outlet-registry.json / review-texts corpus / src tree. No fs,
 * console or process.exit here; the script does the I/O and the printing.
 */

const { parseDate } = require('./date-utils');

const MARKETS = ['west-end', 'off-west-end', 'off-broadway'];

// update-show-status.js auto-closes 7 days after closingDate
// (CLOSING_GRACE_PERIOD_DAYS) so extensions can be caught; +1 day so the cron
// itself has a chance to run before the gate fires (2026-04-26 incident).
const CLOSING_GRACE_DAYS = 7 + 1;

// Where the per-market review-count threshold lives. score-buckets.ts
// re-exports hasEnoughReviews from min-reviews.js since BRO-4312, so the market
// names must be looked for in both (the script read only score-buckets.ts and
// failed on every run after that move; BRO-5261 retro-review).
const THRESHOLD_SOURCES = ['src/config/score-buckets.ts', 'scripts/lib/min-reviews.js'];

// Shows of this market whose slug lacks the market marker. Off-west-end shows
// keep legacy "west-end" slugs (renaming breaks URLs/SEO), so "west-end" is
// accepted there.
function findSlugMarkerMisses(marketShows, market) {
  return marketShows.filter(s => {
    if (!s.slug) return false;  // slug-less shows are reported once, by findShowsWithoutSlug
    if (market === 'off-west-end') return !s.slug.includes('west-end');
    return !s.slug.includes(market);
  });
}

// Shows with no slug at all. They have no URL; the gate reports each as an
// error (the pre-extraction script crashed on them, which also failed it).
function findShowsWithoutSlug(shows) {
  return shows.filter(s => !s.slug);
}

// Shows of this market whose id lacks the market marker (no legacy exemption).
function findIdMarkerMisses(marketShows, market) {
  return marketShows.filter(s => !s.id.includes(market));
}

// The EXACT same slug used by more than one show (any market). Returns
// [slug, shows[]] pairs in first-seen order. Slug-less shows are skipped
// (findShowsWithoutSlug reports them).
function findSlugCollisions(shows) {
  const bySlug = {};
  for (const show of shows) {
    if (!show.slug) continue;
    if (!bySlug[show.slug]) bySlug[show.slug] = [];
    bySlug[show.slug].push(show);
  }
  return Object.entries(bySlug).filter(([, entries]) => entries.length > 1);
}

// status=open shows whose closingDate is older than the auto-close grace window.
function findStaleOpenShows(marketShows, now = new Date(), graceDays = CLOSING_GRACE_DAYS) {
  const cutoff = new Date(now.getTime());
  cutoff.setDate(cutoff.getDate() - graceDays);
  return marketShows.filter(s =>
    s.status === 'open' && s.closingDate && new Date(s.closingDate) < cutoff
  );
}

// Missing title/category/status, or type once a show is past the stub stage.
// Production type is often unknown until previews are dated (2026-05-26
// discovery fix): exempt while status='announced', and while a provisional
// venue-page stub is 'upcoming' because the venue listed dates but no genre
// (BRO-4396 gives dated stubs the status their dates imply; knownShowType()
// leaves type null rather than guess). Nothing fills it automatically: the
// status flip at previews keeps refusing to guess (announced-promotion.js
// typeForListedShow), so findUntypedStubsNearPreviews warns ahead of that date.
// The exemption names the venue-page source (BRO-5261): other provisional
// sources (manual requests, tour schedules, roundups) still need a type.
function typeExempt(s) {
  if (s.status === 'announced') return true;
  return s.status === 'upcoming' && s.provisional === true
    && String(s.discoverySource || '').startsWith('venue-page');
}
function findMissingRequiredFields(marketShows) {
  return marketShows.filter(
    (s) => !s.title || !s.category || !s.status || (!typeExempt(s) && !s.type),
  );
}

// Exempt upcoming stubs with no type whose first preview is within `days`:
// on that date the row turns 'previews' and findMissingRequiredFields fails.
const UNTYPED_STUB_WARN_DAYS = 30;
function findUntypedStubsNearPreviews(marketShows, now = new Date(), days = UNTYPED_STUB_WARN_DAYS) {
  const horizon = new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
  return marketShows.filter((s) => s.status === 'upcoming' && !s.type && typeExempt(s)
    && s.previewsStartDate && String(s.previewsStartDate).slice(0, 10) <= horizon);
}

// outlet-registry.json → { outletDomains: {id: domain}, outletDomainAliases: {id: [domains]} }
function buildOutletDomainMaps(registryData) {
  const outlets = (registryData && registryData.outlets) || {};
  const outletDomains = {};
  const outletDomainAliases = {};
  for (const [id, outlet] of Object.entries(outlets)) {
    if (outlet.domain) outletDomains[id] = outlet.domain.toLowerCase();
    if (outlet.domainAliases) outletDomainAliases[id] = outlet.domainAliases.map(d => d.toLowerCase());
  }
  return { outletDomains, outletDomainAliases };
}

// Exact domain or subdomain match either way (m.nytimes.com ~ nytimes.com).
function domainOrSub(a, b) {
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

/**
 * Does `url` live on the outlet's domain (or one of its aliases)?
 * Returns null when the URL cannot be parsed (the gate skips such reviews).
 */
function urlMatchesOutletDomain(url, expectedDomain, aliases = []) {
  let urlDomain;
  try { urlDomain = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return null; }
  const expected = expectedDomain.replace(/^www\./, '');
  return domainOrSub(urlDomain, expected)
    || aliases.some(a => domainOrSub(urlDomain, a.replace(/^www\./, '')));
}

/**
 * Review-data stats for one show's review-text files.
 * @param show     shows.json entry (uses openingDate)
 * @param reviews  [{ file, review }] parsed review JSONs (malformed files already dropped)
 * @returns { totalReviews, urlMismatches, duplicatePairs, earlyReviews }
 *
 * Flagged reviews (wrongProduction/wrongShow/duplicateOf/wrongUrl) are excluded.
 * A review with an unparseable URL is counted in totalReviews but skips the
 * dedup and early-date checks (matches the script's original `continue`).
 */
function scanShowReviews(show, reviews, outletDomains, outletDomainAliases) {
  let totalReviews = 0;
  let urlMismatches = 0;
  let earlyReviews = 0;
  const byOutlet = {};

  for (const { file, review } of reviews) {
    try {
      if (review.wrongProduction || review.wrongShow || review.duplicateOf || review.wrongUrl) continue;
      totalReviews++;

      const outletId = review.outletId || file.split('--')[0];

      if (review.url && outletDomains[outletId]) {
        const matches = urlMatchesOutletDomain(review.url, outletDomains[outletId], outletDomainAliases[outletId] || []);
        if (matches === null) continue;
        if (!matches) urlMismatches++;
      }

      if (!byOutlet[outletId]) byOutlet[outletId] = [];
      byOutlet[outletId].push(file);

      // Early date check (>1 year before opening)
      if (review.publishDate && show.openingDate) {
        const pub = parseDate(review.publishDate);
        const open = new Date(show.openingDate);
        const daysBefore = pub ? (open - pub) / (1000 * 60 * 60 * 24) : 0;
        if (daysBefore > 365) earlyReviews++;
      }
    } catch (e) {
      // skip malformed records
    }
  }

  let duplicatePairs = 0;
  for (const files of Object.values(byOutlet)) {
    if (files.length > 1) duplicatePairs++;
  }
  return { totalReviews, urlMismatches, duplicatePairs, earlyReviews };
}

// score-buckets.ts / ScoreBadge+market-utils handle a market iff they quote it.
function sourceHandlesMarket(content, market) {
  return content.includes(`'${market}'`);
}

// Browse page must serialize category or market thresholds break on browse.
function browseSerializesCategory(content) {
  return content.includes('category:') && content.includes('show.category');
}

// Site name seo.ts must reference for each market.
function seoMarkerFor(market) {
  return market === 'west-end' ? 'West End Scorecard' : market === 'off-west-end' ? 'Off-West End Scorecard' : 'Off-Broadway Scorecard';
}

// Final verdict from the error/warning tallies.
function summarize(errors, warnings) {
  if (errors > 0) return { exitCode: 1, status: 'failed' };
  if (warnings > 0) return { exitCode: 0, status: 'warnings' };
  return { exitCode: 0, status: 'passed' };
}

module.exports = {
  THRESHOLD_SOURCES,
  MARKETS,
  UNTYPED_STUB_WARN_DAYS,
  findUntypedStubsNearPreviews,
  CLOSING_GRACE_DAYS,
  findSlugMarkerMisses,
  findIdMarkerMisses,
  findShowsWithoutSlug,
  findSlugCollisions,
  findStaleOpenShows,
  findMissingRequiredFields,
  buildOutletDomainMaps,
  urlMatchesOutletDomain,
  scanShowReviews,
  sourceHandlesMarket,
  browseSerializesCategory,
  seoMarkerFor,
  summarize,
};
