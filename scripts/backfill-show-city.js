#!/usr/bin/env node
/**
 * One-off backfill (BRO-6515): set `city` (metro slug from data/venue-metros.json)
 * on every regional show. Tour shows are multi-city (their stops live in
 * data/tour-schedules.json) so they get no single city and are reported, not set.
 *
 * Usage: node scripts/backfill-show-city.js [--dry-run]
 */
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { resolveMetro } = require('./lib/venue-metro');

const DRY_RUN = process.argv.includes('--dry-run');

function backfill(shows) {
  const set = [];
  const unmapped = [];
  let tours = 0;
  for (const s of shows) {
    if (s.market === 'tour') { tours++; continue; }
    if (s.market !== 'regional') continue;
    const metro = resolveMetro(s.venue);
    if (!metro) { unmapped.push(`${s.id}: ${s.venue}`); continue; }
    if (s.city !== metro) { set.push(`${s.id} -> ${metro}`); s.city = metro; }
  }
  return { set, unmapped, tours };
}

if (require.main === module) {
  const data = loadShows();
  const { set, unmapped, tours } = backfill(data.shows);
  console.log(`city set on ${set.length} regional show(s)${DRY_RUN ? ' (dry run)' : ''}:`);
  set.forEach((l) => console.log(`  ${l}`));
  console.log(`${tours} tour show(s) skipped: multi-city, stops are in data/tour-schedules.json`);
  console.log(`UNMAPPED regional shows (${unmapped.length}):`);
  unmapped.forEach((l) => console.log(`  ${l}`));
  if (!DRY_RUN && set.length) saveShows(data, { reason: 'BRO-6515 backfill show city' });
}

module.exports = { backfill };
