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

// Production categories
const PAGES = {
  'Outstanding Musical':              'Drama_Desk_Award_for_Outstanding_Musical',
  'Outstanding Play':                 'Drama_Desk_Award_for_Outstanding_Play',
  'Outstanding Revival of a Musical': 'Drama_Desk_Award_for_Outstanding_Revival_of_a_Musical',
  'Outstanding Revival of a Play':    'Drama_Desk_Award_for_Outstanding_Revival_of_a_Play',
  // Performance categories (separate Actor/Actress pages predate merged "Lead Performance" 2022+)
  'Outstanding Actor in a Musical':           'Drama_Desk_Award_for_Outstanding_Actor_in_a_Musical',
  'Outstanding Actress in a Musical':         'Drama_Desk_Award_for_Outstanding_Actress_in_a_Musical',
  'Outstanding Actor in a Play':              'Drama_Desk_Award_for_Outstanding_Actor_in_a_Play',
  'Outstanding Actress in a Play':            'Drama_Desk_Award_for_Outstanding_Actress_in_a_Play',
  'Outstanding Featured Actor in a Musical':  'Drama_Desk_Award_for_Outstanding_Featured_Actor_in_a_Musical',
  'Outstanding Featured Actress in a Musical':'Drama_Desk_Award_for_Outstanding_Featured_Actress_in_a_Musical',
  'Outstanding Featured Actor in a Play':     'Drama_Desk_Award_for_Outstanding_Featured_Actor_in_a_Play',
  'Outstanding Featured Actress in a Play':   'Drama_Desk_Award_for_Outstanding_Featured_Actress_in_a_Play',
  // Merged "Lead Performance" (2022+, replaces Actor/Actress)
  'Outstanding Lead Performance in a Musical':'Drama_Desk_Award_for_Outstanding_Lead_Performance_in_a_Musical',
  'Outstanding Lead Performance in a Play':   'Drama_Desk_Award_for_Outstanding_Lead_Performance_in_a_Play',
  // Direction + choreography
  'Outstanding Direction of a Musical': 'Drama_Desk_Award_for_Outstanding_Direction_of_a_Musical',
  'Outstanding Direction of a Play':    'Drama_Desk_Award_for_Outstanding_Direction_of_a_Play',
  'Outstanding Choreography':           'Drama_Desk_Award_for_Outstanding_Choreography',
  // Composition
  'Outstanding Book of a Musical': 'Drama_Desk_Award_for_Outstanding_Book_of_a_Musical',
  'Outstanding Music':             'Drama_Desk_Award_for_Outstanding_Music',
  'Outstanding Lyrics':            'Drama_Desk_Award_for_Outstanding_Lyrics',
  'Outstanding Orchestrations':    'Drama_Desk_Award_for_Outstanding_Orchestrations',
  // Design (split into Musical/Play categories since ~2000)
  'Outstanding Scenic Design of a Musical':   'Drama_Desk_Award_for_Outstanding_Scenic_Design_of_a_Musical',
  'Outstanding Scenic Design of a Play':      'Drama_Desk_Award_for_Outstanding_Scenic_Design_of_a_Play',
  'Outstanding Costume Design of a Musical':  'Drama_Desk_Award_for_Outstanding_Costume_Design_of_a_Musical',
  'Outstanding Costume Design of a Play':     'Drama_Desk_Award_for_Outstanding_Costume_Design_of_a_Play',
  'Outstanding Lighting Design of a Musical': 'Drama_Desk_Award_for_Outstanding_Lighting_Design_of_a_Musical',
  'Outstanding Lighting Design of a Play':    'Drama_Desk_Award_for_Outstanding_Lighting_Design_of_a_Play',
  'Outstanding Sound Design of a Musical':    'Drama_Desk_Award_for_Outstanding_Sound_Design_of_a_Musical',
  'Outstanding Sound Design of a Play':       'Drama_Desk_Award_for_Outstanding_Sound_Design_of_a_Play',
  // Newer/specialty categories
  'Outstanding Projection Design': 'Drama_Desk_Award_for_Outstanding_Projection_Design',
  'Outstanding Solo Performance':  'Drama_Desk_Award_for_Outstanding_Solo_Performance',
};

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=1975').split('=')[1],
  10,
);

runCategoryScraper({
  pages: PAGES,
  ceremonyName: 'drama-desk',
  minYear: MIN_YEAR,
  write: process.argv.includes('--write'),
  force: process.argv.includes('--force'),
}).catch((e) => { console.error(e); process.exit(1); });
