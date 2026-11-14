#!/usr/bin/env node
/**
 * Scrape Drama League Awards YEAR-page wikitexts.
 *
 * Page naming: `${ordinal}${suffix}_Drama_League_Awards` where ordinal = year - 1934.
 * (92nd = 2026, 91st = 2025, 90th = 2024.)
 *
 * Usage:
 *   node scripts/scrape-drama-league-year-page.js                 # dry-run recent years
 *   node scripts/scrape-drama-league-year-page.js --year=2026 --write
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
  const ordinal = year - 1934;
  return `${ordinal}${ordinalSuffix(ordinal)}_Drama_League_Awards`;
}

runYearPageScraper({
  ceremonyName: 'drama-league',
  pageTitleFn,
  years: YEARS,
  sectionHeadings: /==\s*(?:Winners and nominees|Awards and nominations|Nominations and winners|Winners|Nominees)\s*==/i,
  // DL has fewer categories than DD/OCC; threshold reflects that.
  categoryPrefixRe: /(?:Outstanding|Distinguished|Special|Mr\.|Mrs\.|Anna|Founders)/i,
  minCategoriesPerYear: 4,
  write: WRITE,
  force: FORCE,
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
