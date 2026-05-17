#!/usr/bin/env node
/**
 * Scrape Drama League Award nominations + winners from Wikipedia.
 *
 * Per-category page scraper. Drama League uses the longest nominee lists of
 * the precursors (often 10+ shows per category-year).
 *
 * Usage:
 *   node scripts/scrape-drama-league.js              # diff vs baseline
 *   node scripts/scrape-drama-league.js --write      # commit
 */

const { runCategoryScraper } = require('./lib/per-category-precursor');

const PAGES = {
  'Outstanding Production of a Musical': 'Drama_League_Award_for_Outstanding_Production_of_a_Musical',
  'Outstanding Production of a Play':    'Drama_League_Award_for_Outstanding_Production_of_a_Play',
  'Outstanding Revival of a Musical':    'Drama_League_Award_for_Outstanding_Revival_of_a_Musical',
  'Outstanding Revival of a Play':       'Drama_League_Award_for_Outstanding_Revival_of_a_Play',
  // Direction sub-categories — Wikipedia has historical coverage. Already
  // 3 yrs in source from hand-curation; this extends to ~30 years.
  'Outstanding Direction of a Musical':  'Drama_League_Award_for_Outstanding_Direction_of_a_Musical',
  'Outstanding Direction of a Play':     'Drama_League_Award_for_Outstanding_Direction_of_a_Play',
};

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=2014').split('=')[1],
  10,
);

runCategoryScraper({
  pages: PAGES,
  ceremonyName: 'drama-league',
  minYear: MIN_YEAR,
  write: process.argv.includes('--write'),
  force: process.argv.includes('--force'),
}).catch((e) => { console.error(e); process.exit(1); });
