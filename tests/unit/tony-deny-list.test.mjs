/**
 * Tony deny-list canary (Sprint B, 2026-05-17).
 *
 * Asserts that specific misattributed Tony entries removed by
 * scripts/fix-tony-attribution.js do not reappear after any re-scrape.
 *
 * Two classes:
 *   1. Deleted blocks — showIds that had their entire tony block removed
 *      because the data belonged to a different production or show ID.
 *   2. Removed wins — specific win category strings removed from shows
 *      that legitimately have a Tony block but had phantom wins.
 *
 * If any assertion fails after a scrape, investigate whether:
 *   a. The scraper is re-adding the wrong season/production
 *   b. A match-logic bug caused re-attribution to the wrong show ID
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const awards = JSON.parse(readFileSync(path.join(__dirname, '../../data/awards.json'), 'utf8'));

// Shows whose entire tony block was deleted because the stored data
// demonstrably belonged to a different production or had no valid Tony record.
// NOTE: grease-1994, play-on-1997, a-day-in-the-death-of-joe-egg-2003,
// on-golden-pond-2005, 1776-2022, the-threepenny-opera-2006,
// angels-in-america-2018, a-view-from-the-bridge-2010 were removed from
// this list after SB-T3 (2026-05-17) — the scraper now populates correct
// season data for these shows. Only shows with no legitimate Tony record,
// WE/OB shows, or shows where wrong-production data can't be disambiguated
// by year remain here.
const DELETED_TONY_BLOCKS = [
  // Wrong production — Tony data belongs to a different production year
  'hair-2011',                      // "Best Revival of a Musical" belongs to hair-2009, not 2011 transfer
  'purlie-1972',                    // 1970 Tony wins; shows.json date 1972-12-27 is a different production
  'private-lives-2025',             // OB 2025 tagged with 1969 Tammy Grimes Tony (Broadway-only)
  'monte-cristo-the-york-theatre-company-off-broadway-2026', // OB 2026 tagged with 1970-71 Tony (Broadway-only)
  // West End shows (Tonys are Broadway-only)
  'a-month-in-the-country-west-end-2026',
  'man-to-man-west-end-2026',
  'oh-mary-west-end-2025',
  // Empty metadata stubs with no legitimate Tony record
  'harvey-2012',
  'fiddler-on-the-roof-1976',
  'out-cry-1973',
];

// Specific wins removed from shows that legitimately have a Tony block.
// The listed category MUST NOT appear in the wins array of the given show.
const REMOVED_WINS = [
  { showId: 'porgy-and-bess-1976',          win: 'Best Actress in a Musical' },   // Dorothy Loudon (Annie) won
  { showId: 'the-cherry-orchard-1977',      win: 'Best Costume Design' },          // Theoni V. Aldredge (Annie) won
  { showId: 'talleys-folly-1980',           win: 'Best Scenic Design' },            // David Mitchell (Barnum) won
  { showId: 'little-me-1982',               win: 'Best Actor in a Musical' },       // Ben Harney (Dreamgirls) won
  { showId: 'you-cant-take-it-with-you-1983', win: 'Best Actress in a Play' },      // Jessica Tandy (Foxfire) won
  { showId: 'cabaret-1987',                 win: 'Best Actor in a Musical' },        // Michael Crawford (Phantom) won
  { showId: 'cabaret-1987',                 win: 'Best Actress in a Musical' },      // Joanna Gleason (Into the Woods) won
  { showId: 'cabaret-1987',                 win: 'Best Featured Actor in a Musical' }, // Bill McCutcheon (Anything Goes) won
];

test('deleted tony blocks do not reappear', () => {
  const reappeared = DELETED_TONY_BLOCKS.filter(
    id => awards.shows[id]?.tony,
  );
  assert.deepEqual(
    reappeared,
    [],
    `These shows had their tony block deleted but it reappeared:\n${reappeared.join('\n')}\n\nInvestigate scraper match logic — it re-attributed wrong production data.`,
  );
});

test('removed wins do not reappear', () => {
  const reappeared = REMOVED_WINS.filter(({ showId, win }) => {
    const wins = awards.shows[showId]?.tony?.wins ?? [];
    return wins.includes(win);
  });
  assert.deepEqual(
    reappeared,
    [],
    `These phantom wins reappeared:\n${reappeared.map(r => `  ${r.showId}: "${r.win}"`).join('\n')}\n\nThese wins were removed because the real winner was a different show. Check scraper season-match logic.`,
  );
});
