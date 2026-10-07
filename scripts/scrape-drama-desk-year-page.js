#!/usr/bin/env node
/**
 * Scrape Drama Desk Awards YEAR-page wikitexts.
 *
 * Per-category DD pages (scripts/scrape-drama-desk.js) store winners as
 * PERSON names with show pairing lost, so enrich's adjacency rule
 * misattributes craft/acting wins. Year pages render `'''[[Person]], ''[[Show]]'''''`
 * — winner field = show, person preserved in winnerPersonName.
 *
 * Page naming: `${ordinal}th_Drama_Desk_Awards` where ordinal = year - 1956.
 * (70th = 2026, 69th = 2025, 60th = 2016, etc.)
 *
 * Usage:
 *   node scripts/scrape-drama-desk-year-page.js                 # dry-run recent years
 *   node scripts/scrape-drama-desk-year-page.js --year=2026 --write
 *   node scripts/scrape-drama-desk-year-page.js --years=2024,2025,2026 --write
 */

const { runYearPageScraper } = require('./lib/year-page-precursor');

const DEFAULT_YEARS = [2024, 2025, 2026];
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');
const YEAR_ARG = process.argv.find((a) => a.startsWith('--year='));
const YEARS_ARG = process.argv.find((a) => a.startsWith('--years='));

let YEARS = DEFAULT_YEARS;
if (YEAR_ARG) YEARS = [parseInt(YEAR_ARG.split('=')[1], 10)];
else if (YEARS_ARG) YEARS = YEARS_ARG.split('=')[1].split(',').map((y) => parseInt(y, 10));

function ordinalSuffix(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

function pageTitleFn(year) {
  const ordinal = year - 1956;
  return `${ordinal}${ordinalSuffix(ordinal)}_Drama_Desk_Awards`;
}

runYearPageScraper({
  ceremonyName: 'drama-desk',
  pageTitleFn,
  years: YEARS,
  sectionHeadings: /==\s*(?:Winners and nominees|Awards and nominations|Nominations and winners)\s*==/i,
  categoryPrefixRe: /(?:Outstanding|Special|Ensemble|Sam Norkin)/i,
  minCategoriesPerYear: 15,
  write: WRITE,
  force: FORCE,
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
