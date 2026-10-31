#!/usr/bin/env node
/**
 * Generate the West End archive JSON for lazy-loading closed London shows
 * into homepage search (BRO-4872).
 *
 * The homepage used to pass every scored West End show inline as the
 * westEndShows prop, closed ones included, only so its search box could find
 * them. The West End historical backfill (BRO-4851) keeps promoting closed
 * seasons, so the homepage document grew with each one: 195 of the 272 inlined
 * West End shows were closed on 2026-10-08, roughly half of a 1.03MB page, and
 * page-weight-budget.spec.ts went red on main. The homepage now inlines only
 * active West End shows and fetches this file with homepage-archive.json when
 * the user searches.
 *
 * Market membership mirrors getWestEndShows() in src/lib/data-core.ts:
 * belongsOnWestEndListing() (west-end or off-west-end category, theatrical
 * genre) minus HIDDEN_LONDON_IDS. Each entry keeps its own category so search
 * results badge Off-West End shows correctly, and the review floor follows
 * the per-category MIN_REVIEWS_FOR_SCORE_* constants in
 * src/config/score-buckets.ts (West End 5, Off-West End 3).
 *
 * Generates: public/data/west-end-archive.json
 * Run: node scripts/generate-west-end-archive.js
 * Or via: npm run prebuild
 */

const { generateMarketArchive } = require('./lib/generate-market-archive');
const { isNonTheatricalGenre } = require('./lib/genre-classification');
const { HIDDEN_LONDON_IDS } = require('./lib/page-name-sources');

const MIN_REVIEWS_WEST_END = 5;
const MIN_REVIEWS_OFF_WEST_END = 3;

generateMarketArchive({
  outputFilename: 'west-end-archive.json',
  entryCategory: show => show.category,
  belongsToMarket: show =>
    (show.category === 'west-end' || show.category === 'off-west-end') &&
    !isNonTheatricalGenre(show.genre),
  excludeIds: HIDDEN_LONDON_IDS,
  minReviews: show => (show.category === 'off-west-end' ? MIN_REVIEWS_OFF_WEST_END : MIN_REVIEWS_WEST_END),
  label: 'West End',
});
