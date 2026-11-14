#!/usr/bin/env node
/**
 * Scrape Critics' Circle Theatre Award winners from Wikipedia.
 *
 * CC does NOT have per-category Wikipedia pages — all category URLs redirect
 * to the same combined page. The shared per-category-precursor.js template
 * (used by DD/OCC/DL/etc.) doesn't work here because all 5 fetches return
 * the same page, producing identical (and wrong) nominee lists for every
 * category. See scripts/lib/critics-circle-parser.js for the custom parser.
 *
 * Critics' Circle is winner-only — no nominee lists are published. Each
 * entry has `winner` + `nominees: [winner]` for schema symmetry with
 * DD/OCC/DL.
 *
 * Usage:
 *   node scripts/scrape-critics-circle.js              # dry-run diff vs baseline
 *   node scripts/scrape-critics-circle.js --write      # commit data/precursors/critics-circle.json
 *   node scripts/scrape-critics-circle.js --min-year=2000
 *   node scripts/scrape-critics-circle.js --force      # bypass shrink-guard
 */

const path = require('path');
const fs = require('fs');
const { fetchCCPage, extractCategoryEntries } = require('./lib/critics-circle-parser');
const { writePrecursorJson, PRECURSORS_DIR } = require('./lib/precursor-wikipedia');

const CATEGORIES = [
  'Best New Play',
  'Best Actor',
  'Best Actress',
  'Best Director',
  'Most Promising Playwright',
];

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=1990').split('=')[1],
  10,
);

(async () => {
  console.log(`Fetching combined CC page (one HTTP fetch, ${CATEGORIES.length} categories)...`);
  const html = await fetchCCPage();
  console.log(`  Got ${(html.length / 1024).toFixed(1)} KB`);

  const result = {};
  for (const category of CATEGORIES) {
    try {
      const entries = extractCategoryEntries(html, category, MIN_YEAR);
      const first = entries[0]?.year;
      const last = entries[entries.length - 1]?.year;
      console.log(`  ${category}: ${entries.length} entries (years ${first}-${last})`);
      result[category] = entries;
    } catch (e) {
      console.log(`  ${category}: PARSE ERROR — ${e.message}`);
      result[category] = [];
    }
  }

  // Diff vs baseline for visibility
  const fp = path.join(PRECURSORS_DIR, 'critics-circle.json');
  if (fs.existsSync(fp)) {
    const baseline = JSON.parse(fs.readFileSync(fp, 'utf8')).data || {};
    console.log('\nDiff vs baseline (winners changed):');
    for (const cat of CATEGORIES) {
      const newByYear = new Map(result[cat].map((e) => [e.year, e.winner]));
      const baseByYear = new Map((baseline[cat] || []).map((e) => [e.year, e.winner]));
      const changed = [];
      for (const [y, w] of newByYear) {
        const old = baseByYear.get(y);
        if (old !== w) changed.push(`${y}:${old || '∅'}→${w || '∅'}`);
      }
      console.log(`  ${cat}: ${changed.length === 0 ? 'no changes' : changed.slice(0, 5).join(', ') + (changed.length > 5 ? ` (+${changed.length - 5} more)` : '')}`);
    }
  }

  const out = writePrecursorJson('critics-circle', result, {
    force: process.argv.includes('--force'),
    dryRun: !process.argv.includes('--write'),
    meta: { sourcePages: ["Critics'_Circle_Theatre_Award"], minYear: MIN_YEAR },
  });
  console.log(
    out.written
      ? `\nWrote ${out.fp} (${out.newCount} entries, was ${out.oldCount})`
      : `\nDry run; pass --write to overwrite (${out.newCount} entries vs baseline ${out.oldCount})`
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
