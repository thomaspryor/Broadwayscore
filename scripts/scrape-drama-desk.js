#!/usr/bin/env node
/**
 * Scrape Drama Desk Award nominations + winners from Wikipedia.
 *
 * One Wikipedia page per category; one master wikitable each. Output is a
 * drop-in source for enrich-awards-with-precursors.js.
 *
 * Usage:
 *   node scripts/scrape-drama-desk.js              # diff vs baseline (default)
 *   node scripts/scrape-drama-desk.js --write      # write data/precursors/drama-desk.json
 *   node scripts/scrape-drama-desk.js --force      # write even if entries shrunk >5%
 *   node scripts/scrape-drama-desk.js --min-year=2014
 */

const { runCategoryScraper } = require('./lib/per-category-precursor');

const PAGES = {
  'Outstanding Musical':              'Drama_Desk_Award_for_Outstanding_Musical',
  'Outstanding Play':                 'Drama_Desk_Award_for_Outstanding_Play',
  'Outstanding Revival of a Musical': 'Drama_Desk_Award_for_Outstanding_Revival_of_a_Musical',
  'Outstanding Revival of a Play':    'Drama_Desk_Award_for_Outstanding_Revival_of_a_Play',
};

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=2014').split('=')[1],
  10,
);

runCategoryScraper({
  pages: PAGES,
  ceremonyName: 'drama-desk',
  minYear: MIN_YEAR,
  write: process.argv.includes('--write'),
  force: process.argv.includes('--force'),
}).catch((e) => { console.error(e); process.exit(1); });
