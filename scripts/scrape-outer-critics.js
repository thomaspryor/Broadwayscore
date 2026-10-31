#!/usr/bin/env node
/**
 * Scrape Outer Critics Circle Award nominations + winners from Wikipedia.
 *
 * Per-category page scraper. Output drops into enrich-awards-with-precursors.js.
 *
 * Usage:
 *   node scripts/scrape-outer-critics.js              # diff vs baseline
 *   node scripts/scrape-outer-critics.js --write      # commit to data/precursors/outer-critics.json
 */

const { runCategoryScraper } = require('./lib/per-category-precursor');

// Production categories
const PAGES = {
  'Outstanding New Broadway Musical': 'Outer_Critics_Circle_Award_for_Outstanding_New_Broadway_Musical',
  'Outstanding New Broadway Play':    'Outer_Critics_Circle_Award_for_Outstanding_New_Broadway_Play',
  'Outstanding Revival of a Musical': 'Outer_Critics_Circle_Award_for_Outstanding_Revival_of_a_Musical',
  'Outstanding Revival of a Play':    'Outer_Critics_Circle_Award_for_Outstanding_Revival_of_a_Play',
  // Performance categories
  'Outstanding Actor in a Musical':           'Outer_Critics_Circle_Award_for_Outstanding_Actor_in_a_Musical',
  'Outstanding Actress in a Musical':         'Outer_Critics_Circle_Award_for_Outstanding_Actress_in_a_Musical',
  'Outstanding Actor in a Play':              'Outer_Critics_Circle_Award_for_Outstanding_Actor_in_a_Play',
  'Outstanding Actress in a Play':            'Outer_Critics_Circle_Award_for_Outstanding_Actress_in_a_Play',
  'Outstanding Featured Actor in a Musical':  'Outer_Critics_Circle_Award_for_Outstanding_Featured_Actor_in_a_Musical',
  'Outstanding Featured Actress in a Musical':'Outer_Critics_Circle_Award_for_Outstanding_Featured_Actress_in_a_Musical',
  'Outstanding Featured Actor in a Play':     'Outer_Critics_Circle_Award_for_Outstanding_Featured_Actor_in_a_Play',
  'Outstanding Featured Actress in a Play':   'Outer_Critics_Circle_Award_for_Outstanding_Featured_Actress_in_a_Play',
  // Direction + choreography
  'Outstanding Direction of a Musical': 'Outer_Critics_Circle_Award_for_Outstanding_Direction_of_a_Musical',
  'Outstanding Direction of a Play':    'Outer_Critics_Circle_Award_for_Outstanding_Direction_of_a_Play',
  'Outstanding Choreography':           'Outer_Critics_Circle_Award_for_Outstanding_Choreography',
  // Composition
  'Outstanding New Score':         'Outer_Critics_Circle_Award_for_Outstanding_New_Score',
  'Outstanding Book of a Musical': 'Outer_Critics_Circle_Award_for_Outstanding_Book_of_a_Musical',
};

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=1975').split('=')[1],
  10,
);

runCategoryScraper({
  pages: PAGES,
  ceremonyName: 'outer-critics',
  minYear: MIN_YEAR,
  write: process.argv.includes('--write'),
  force: process.argv.includes('--force'),
}).catch((e) => { console.error(e); process.exit(1); });
