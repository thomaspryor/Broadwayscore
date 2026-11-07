#!/usr/bin/env node
/**
 * Scrape Outer Critics Circle Awards YEAR-page wikitexts.
 *
 * Migrated 2026-05-25 to use the shared scripts/lib/year-page-precursor.js
 * library so DD + DL year-page scrapers can share the same parser.
 *
 * Usage:
 *   node scripts/scrape-occ-year-page.js              # dry-run gap years
 *   node scripts/scrape-occ-year-page.js --write
 *   node scripts/scrape-occ-year-page.js --year=2024 --write
 */

const { runYearPageScraper } = require('./lib/year-page-precursor');

const GAP_YEARS = [2022, 2023, 2024, 2025, 2026];
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');
const YEAR_ARG = process.argv.find((a) => a.startsWith('--year='));
const YEARS = YEAR_ARG ? [parseInt(YEAR_ARG.split('=')[1], 10)] : GAP_YEARS;

runYearPageScraper({
  ceremonyName: 'outer-critics',
  pageTitleFn: (year) => `${year}_Outer_Critics_Circle_Awards`,
  years: YEARS,
  sectionHeadings: /==\s*(?:Winners and nominees|Awards and nominations|Nominations and winners)\s*==/i,
  categoryPrefixRe: /(?:Outstanding|Best|John Gassner|Special)/i,
  minCategoriesPerYear: 10,
  write: WRITE,
  force: FORCE,
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
