#!/usr/bin/env node
/**
 * discover-historical-shows-we.js
 *
 * WE historical backfill, season discovery (BRO-4851, plan v3.1:
 * docs/specs/west-end-historical-backfill-v3.md). DISCOVERY ONLY — never
 * writes shows.json. Writes data/audit/we-historical-candidates-<season>.json;
 * promote-historical-we.js writes the promotable subset.
 *
 * Sources (all free JSON APIs, runnable locally, no credentials):
 *   - WhatsOnStage London listings (lib/wos-rest-listings.js), filtered to
 *     isWestEndVenue(): the dated primary listing — venue, previews,
 *     opening, closing.
 *   - WhatsOnStage review posts in the season window: review signal.
 *   - Olivier ceremony nominees for the two ceremonies a season can fall in
 *     (lib/olivier-ceremony-wikipedia.js): independent review signal.
 * Each listing gets a decision from decideWeHistoricalPromotion()
 * (lib/we-historical-corroboration.js).
 *
 * v2.2 read a "YYYY–YY West End theatre season" Wikipedia article; no such
 * article exists for any season (404, verified 2026-10-07), so it always
 * found 0 candidates.
 *
 * Known limit: WOS listings are thin before 2018-19 (1 row for 2016-17, 22
 * for 2017-18). Those seasons need review-post-led discovery (plan Phase C).
 *
 * Usage:
 *   node scripts/discover-historical-shows-we.js --season=2024-2025 [--verbose]
 */

'use strict';

// venue-write-guard-ok: venue goes to the candidates audit file only; promote-historical-we.js routes the shows.json write through sanitizeVenueForWrite.

const fs = require('fs');
const path = require('path');

const { validateSeason, getSeasonDates, isDateInSeason } = require('./lib/we-seasons');
const { normalizeTitle } = require('./lib/title-match');
const { venuesMatch } = require('./lib/deduplication');
const { isWestEndVenue } = require('./lib/venue-classification');
const { buildVenueTitlePool, findExactDuplicate, findSubtitleDuplicateTitle } = require('./lib/venue-title-dedup-pool');
const { venueFamily, signalMatchesListing, decideWeHistoricalPromotion } = require('./lib/we-historical-corroboration');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `discover-historical-shows-we.js — List West End productions for a season that are not in shows.json. Writes candidates only.

Usage:
  node scripts/discover-historical-shows-we.js --season=YYYY-YYYY [options]

Options:
  --verbose     Print every candidate, not just promotable ones
  --help, -h    print this usage and exit
`;

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const DAY_MS = 86400000;

function candidatesPath(season) {
  return path.join(ROOT, 'data', 'audit', `we-historical-candidates-${season}.json`);
}

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = data.shows || data;
  return Array.isArray(shows) ? shows : Object.values(shows);
}

const isoDay = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => isoDay(new Date(Date.parse(iso) + n * DAY_MS));

/** Venue equality for matching against shows.json rows: venuesMatch plus NT/Royal Court/@sohoplace naming variants. */
function sameVenue(a, b) {
  return venuesMatch(a, b) || venueFamily(a) === venueFamily(b);
}

/**
 * WOS sometimes lists one production twice (a "West End" suffixed duplicate,
 * a re-listed run). Collapse rows with the same title + venue family whose
 * start dates are within 30 days, keeping the one with an opening date.
 */
function collapseDuplicateListings(rows) {
  const out = [];
  for (const r of rows) {
    const start = Date.parse(r.openingDate || r.previewsStartDate);
    const twin = out.find(o => normalizeTitle(o.title) === normalizeTitle(r.title)
      && venueFamily(o.venue) === venueFamily(r.venue)
      && Math.abs(Date.parse(o.openingDate || o.previewsStartDate) - start) <= 30 * DAY_MS);
    if (!twin) { out.push(r); continue; }
    if (!twin.openingDate && r.openingDate) Object.assign(twin, r);
  }
  return out;
}

const MAX_PREVIEW_DAYS = 42;

/** WOS opening_date, or null when it is a placeholder (= first preview) or implausibly late. */
function plausibleOpeningDate(l) {
  if (!l.openingDate) return null;
  if (!l.previewsStartDate) return l.openingDate;
  const gapDays = (Date.parse(l.openingDate) - Date.parse(l.previewsStartDate)) / DAY_MS;
  return gapDays > 0 && gapDays <= MAX_PREVIEW_DAYS ? l.openingDate : null;
}

/**
 * Pure: listings + signals + shows.json → candidate rows with decisions.
 * @param {{season: string, listings: Array, reviews: Array, oliviers: Array, shows: Array, today?: string}} input
 */
function buildCandidates({ season, listings, reviews, oliviers, shows, today }) {
  const inSeason = listings.filter(l => {
    const start = l.openingDate || l.previewsStartDate;
    return start && l.venue && isWestEndVenue(l.venue) && isDateInSeason(start, season);
  });
  const pool = buildVenueTitlePool(shows);
  const westEndIds = new Set(shows.filter(s => s.market === 'west-end').map(s => s.id));
  const candidates = [];
  for (const l of collapseDuplicateListings(inSeason)) {
    const signals = [];
    const review = reviews.find(r => signalMatchesListing(r, l));
    if (review) signals.push('wos-review');
    for (const o of oliviers) {
      if (signalMatchesListing(o, l) && !signals.includes(`olivier-${o.year}`)) signals.push(`olivier-${o.year}`);
    }
    const startDate = l.openingDate || l.previewsStartDate;
    const dupOpts = { withinYears: 1, startDate, venueEquals: sameVenue };
    const existing = findExactDuplicate(pool, l.title, l.venue, dupOpts)
      // Same title + start within a week at a DIFFERENT venue: the same
      // production with a wrong venue on one side (burlesque-west-end-2026
      // says "The Arts at Marble Arch"; WOS says Savoy, same 2025-07-22
      // start). Treat as present rather than mint a second row.
      || pool.find(s => s.startDate && westEndIds.has(s.id) && normalizeTitle(s.title) === normalizeTitle(l.title)
        && Math.abs(Date.parse(s.startDate) - Date.parse(startDate)) <= 7 * DAY_MS);
    const subtitleOf = !existing && findSubtitleDuplicateTitle(pool, l.title, l.venue, dupOpts);
    const candidate = {
      title: l.title,
      venue: l.venue,
      previewsStartDate: l.previewsStartDate,
      // WOS fills opening_date with the first preview for many listings (26
      // of 144 in 2024-25). A press night on the first performance is rare
      // in the West End, so treat equal dates as "opening unknown" rather
      // than write a placeholder as the opening night.
      // Likewise an "opening" more than 6 weeks after the first preview is
      // not a press night (Macbeth, Harold Pinter 2024: WOS says 12-08 for a
      // run that opened in October and closed 12-14).
      openingDate: plausibleOpeningDate(l),
      closingDate: l.closingDate,
      genres: l.genres || [],
      season,
      signals,
      sourceUrls: { wos: l.url, ...(review ? { wosReview: review.url } : {}) },
      inShowsJson: existing ? (existing.id || existing.title) : (subtitleOf || null),
    };
    candidate.decision = candidate.inShowsJson
      ? { promotable: false, persistent: true, reason: `already in shows.json: ${candidate.inShowsJson}` }
      : decideWeHistoricalPromotion(candidate, { today });
    candidates.push(candidate);
  }
  candidates.sort((a, b) => String(a.openingDate || a.previewsStartDate).localeCompare(String(b.openingDate || b.previewsStartDate)));

  // Reviews of West End-venue productions that matched no listing: surfaced
  // for a human, never promoted (they carry no dates to build a row from).
  const unlistedReviews = reviews.filter(r => r.venue && isWestEndVenue(r.venue)
    && isDateInSeason(r.date, season)
    && !inSeason.some(l => signalMatchesListing(r, l)));

  return { candidates, unlistedReviews };
}

async function main() {
  const args = process.argv.slice(2);
  const season = args.find(a => a.startsWith('--season='))?.split('=')[1];
  const verbose = args.includes('--verbose');
  if (!season) { console.error('Usage: node scripts/discover-historical-shows-we.js --season=YYYY-YYYY'); process.exit(2); }
  const check = validateSeason(season);
  if (!check.isValid) { console.error(`Invalid --season: ${check.reason}`); process.exit(2); }

  // Lazy: keeps `require()` of this module (tests) free of network libs.
  const { fetchWosLondonListings, fetchWosReviews } = require('./lib/wos-rest-listings');
  const { fetchOlivierCeremonyNominees } = require('./lib/olivier-ceremony-wikipedia');

  const { start, end } = getSeasonDates(season);
  const startIso = isoDay(start);
  const endIso = isoDay(end);
  console.log(`Discovering West End productions for ${season} (${startIso} → ${endIso})`);

  const listings = await fetchWosLondonListings();
  console.log(`  WOS London listings (all years): ${listings.length}`);
  // Reviews can land a few weeks before opening (previews) and up to ~4
  // months after (a show opening in late August); signalMatchesListing
  // bounds each to its own production's run.
  const reviews = await fetchWosReviews({ after: addDays(startIso, -30), before: addDays(endIso, 120) });
  console.log(`  WOS review posts in window: ${reviews.length}`);
  const endYear = Number(season.split('-')[1]);
  const oliviers = [
    ...(await fetchOlivierCeremonyNominees(endYear)),
    ...(await fetchOlivierCeremonyNominees(endYear + 1)),
  ];
  console.log(`  Olivier nominee lines (${endYear}, ${endYear + 1}): ${oliviers.length}`);
  if (listings.length === 0) {
    console.error('::error::WOS returned 0 listings — API shape or market id changed? Refusing to write an empty candidates file.');
    process.exit(1);
  }

  const { candidates, unlistedReviews } = buildCandidates({ season, listings, reviews, oliviers, shows: loadShows() });

  const promotable = candidates.filter(c => c.decision.promotable);
  console.log('');
  for (const c of candidates) {
    if (!verbose && !c.decision.promotable) continue;
    const mark = c.decision.promotable ? '✓' : '·';
    console.log(`  ${mark} ${c.title} | ${c.venue} | ${c.openingDate || c.previewsStartDate} → ${c.closingDate || '?'} | ${c.decision.reason}`);
  }
  const byReason = {};
  for (const c of candidates.filter(x => !x.decision.promotable)) {
    const key = c.decision.reason.replace(/:.*$/, '').replace(/\(.*$/, '').trim();
    byReason[key] = (byReason[key] || 0) + 1;
  }
  console.log('');
  console.log(`Listings in season at West End venues: ${candidates.length}; promotable: ${promotable.length}`);
  console.log(`Not promotable: ${JSON.stringify(byReason)}`);
  console.log(`WE-venue reviews with no listing (human check): ${unlistedReviews.length}`);

  const out = candidatesPath(season);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    season,
    sources: ['wos-listing', 'wos-review', `olivier-${endYear}`, `olivier-${endYear + 1}`],
    counts: { listings: candidates.length, promotable: promotable.length, notPromotable: byReason, unlistedReviews: unlistedReviews.length },
    candidates,
    unlistedReviews,
  }, null, 2) + '\n');
  console.log(`Wrote ${path.relative(ROOT, out)}`);
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
  main().catch(e => { console.error('Fatal:', e.stack || e.message); process.exit(2); });
}

module.exports = { buildCandidates, collapseDuplicateListings, candidatesPath, plausibleOpeningDate };
