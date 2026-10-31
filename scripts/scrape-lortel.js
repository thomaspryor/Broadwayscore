#!/usr/bin/env node
/**
 * Scrape Lucille Lortel Award nominations + winners from Wikipedia.
 *
 * Per-category page scraper using the shared per-category-precursor.js template.
 * Lortel Awards cover Off-Broadway productions (1986–present).
 *
 * Note: Not all categories have Wikipedia per-category pages. Missing ones
 * (Outstanding Score, Outstanding Book, Direction sub-categories) are omitted
 * here — the 404 handler in per-category-precursor.js would skip them silently.
 *
 * Usage:
 *   node scripts/scrape-lortel.js              # diff vs baseline
 *   node scripts/scrape-lortel.js --write      # commit data/precursors/lortel.json
 */

const { runCategoryScraper } = require('./lib/per-category-precursor');

// Production categories
const PAGES = {
  'Outstanding Musical':  'Lucille_Lortel_Award_for_Outstanding_Musical',
  'Outstanding Play':     'Lucille_Lortel_Award_for_Outstanding_Play',
  'Outstanding Revival':  'Lucille_Lortel_Award_for_Outstanding_Revival',
  // Lead performance categories
  'Outstanding Lead Actor in a Musical':    'Lucille_Lortel_Award_for_Outstanding_Lead_Actor_in_a_Musical',
  'Outstanding Lead Actor in a Play':       'Lucille_Lortel_Award_for_Outstanding_Lead_Actor_in_a_Play',
  'Outstanding Lead Actress in a Musical':  'Lucille_Lortel_Award_for_Outstanding_Lead_Actress_in_a_Musical',
  'Outstanding Lead Actress in a Play':     'Lucille_Lortel_Award_for_Outstanding_Lead_Actress_in_a_Play',
  // Gender-neutral lead performer (newer ceremonies)
  'Outstanding Lead Performer in a Musical': 'Lucille_Lortel_Award_for_Outstanding_Lead_Performer_in_a_Musical',
  'Outstanding Lead Performer in a Play':    'Lucille_Lortel_Award_for_Outstanding_Lead_Performer_in_a_Play',
  // Featured performance categories
  'Outstanding Featured Actor in a Musical':    'Lucille_Lortel_Award_for_Outstanding_Featured_Actor_in_a_Musical',
  'Outstanding Featured Actor in a Play':       'Lucille_Lortel_Award_for_Outstanding_Featured_Actor_in_a_Play',
  'Outstanding Featured Actress in a Musical':  'Lucille_Lortel_Award_for_Outstanding_Featured_Actress_in_a_Musical',
  'Outstanding Featured Actress in a Play':     'Lucille_Lortel_Award_for_Outstanding_Featured_Actress_in_a_Play',
  // Direction + choreography
  'Outstanding Choreographer': 'Lucille_Lortel_Award_for_Outstanding_Choreographer',
  // Design categories
  'Outstanding Scenic Design':      'Lucille_Lortel_Award_for_Outstanding_Scenic_Design',
  'Outstanding Lighting Design':    'Lucille_Lortel_Award_for_Outstanding_Lighting_Design',
  'Outstanding Costume Design':     'Lucille_Lortel_Award_for_Outstanding_Costume_Design',
  'Outstanding Sound Design':       'Lucille_Lortel_Award_for_Outstanding_Sound_Design',
  'Outstanding Projection Design':  'Lucille_Lortel_Award_for_Outstanding_Projection_Design',
  // Solo / special
  'Outstanding Solo Show':     'Lucille_Lortel_Award_for_Outstanding_Solo_Show',
  'Outstanding Body of Work':  'Lucille_Lortel_Award_for_Outstanding_Body_of_Work',
};

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=1986').split('=')[1],
  10,
);

runCategoryScraper({
  pages: PAGES,
  ceremonyName: 'lortel',
  minYear: MIN_YEAR,
  write: process.argv.includes('--write'),
  force: process.argv.includes('--force'),
}).catch((e) => { console.error(e); process.exit(1); });
