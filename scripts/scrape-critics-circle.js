#!/usr/bin/env node
/**
 * Scrape Critics' Circle Theatre Award nominations + winners from Wikipedia.
 *
 * Per-category page scraper using the shared per-category-precursor.js template.
 * Critics' Circle Theatre Awards cover UK/West End theatre (1990–present).
 *
 * Note: Only a subset of categories have Wikipedia per-category pages.
 * Missing categories (Best Musical, Best Revival, Best Design, etc.) do not
 * have Wikipedia pages as of 2026 and are omitted.
 *
 * Usage:
 *   node scripts/scrape-critics-circle.js              # diff vs baseline
 *   node scripts/scrape-critics-circle.js --write      # commit data/precursors/critics-circle.json
 */

const { runCategoryScraper } = require('./lib/per-category-precursor');

const PAGES = {
  'Best New Play':              "Critics%27_Circle_Theatre_Award_for_Best_New_Play",
  'Best Actor':                 "Critics%27_Circle_Theatre_Award_for_Best_Actor",
  'Best Actress':               "Critics%27_Circle_Theatre_Award_for_Best_Actress",
  'Best Director':              "Critics%27_Circle_Theatre_Award_for_Best_Director",
  'Most Promising Playwright':  "Critics%27_Circle_Theatre_Award_for_Most_Promising_Playwright",
};

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=1990').split('=')[1],
  10,
);

runCategoryScraper({
  pages: PAGES,
  ceremonyName: 'critics-circle',
  minYear: MIN_YEAR,
  write: process.argv.includes('--write'),
  force: process.argv.includes('--force'),
}).catch((e) => { console.error(e); process.exit(1); });
