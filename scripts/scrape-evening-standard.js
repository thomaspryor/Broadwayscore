#!/usr/bin/env node
/**
 * Scrape Evening Standard Theatre Award winners from Wikipedia.
 *
 * ES has per-category Wikipedia pages but with a different row format than
 * DD: each ceremony is identified by an ordinal ("1st", "70th"), not a year.
 * Custom parser at scripts/lib/evening-standard-parser.js converts the
 * ordinal to a year (FIRST_CEREMONY_YEAR=1955 + ordinal - 1, falling back
 * to explicit year in parenthesis when present).
 *
 * Categories scraped (4 confirmed to have Wikipedia pages):
 *   - Best Play
 *   - Best Musical
 *   - Best Actor
 *   - Best Actress
 * (Best Director, Editor's Award, Most Promising Playwright have no
 * Wikipedia pages as of 2026 → omitted.)
 *
 * ES is winner-only — no nominee lists are published.
 *
 * Usage:
 *   node scripts/scrape-evening-standard.js              # dry-run diff vs baseline
 *   node scripts/scrape-evening-standard.js --write
 *   node scripts/scrape-evening-standard.js --min-year=2000
 *   node scripts/scrape-evening-standard.js --force
 */

const path = require('path');
const fs = require('fs');
const { fetchESPage, extractCategoryEntries } = require('./lib/evening-standard-parser');
const { writePrecursorJson, PRECURSORS_DIR } = require('./lib/precursor-wikipedia');

const PAGES = {
  'Best Play':    'Best_Play',
  'Best Musical': 'Best_Musical',
  'Best Actor':   'Best_Actor',
  'Best Actress': 'Best_Actress',
};

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=1990').split('=')[1],
  10,
);

(async () => {
  const result = {};
  for (const [category, slug] of Object.entries(PAGES)) {
    process.stdout.write(`Fetching ${slug}... `);
    try {
      const html = await fetchESPage(slug);
      const entries = extractCategoryEntries(html, category, MIN_YEAR);
      const first = entries[0]?.year;
      const last = entries[entries.length - 1]?.year;
      console.log(`${entries.length} entries (years ${first}-${last})`);
      result[category] = entries;
    } catch (e) {
      if (e.message.includes('HTTP 404')) {
        console.log('SKIP (404 — page does not exist)');
        result[category] = [];
      } else {
        console.log(`ERROR: ${e.message}`);
        result[category] = [];
      }
    }
  }

  const fp = path.join(PRECURSORS_DIR, 'evening-standard.json');
  if (fs.existsSync(fp)) {
    const baseline = JSON.parse(fs.readFileSync(fp, 'utf8')).data || {};
    console.log('\nDiff vs baseline:');
    for (const cat of Object.keys(PAGES)) {
      const newByYear = new Map(result[cat].map((e) => [e.year, e.winner]));
      const baseByYear = new Map((baseline[cat] || []).map((e) => [e.year, e.winner]));
      const added = [];
      for (const [y, w] of newByYear) if (!baseByYear.has(y)) added.push(`${y}:${w}`);
      console.log(`  ${cat}: ${added.length} new entries (${added.slice(0, 3).join(', ')}${added.length > 3 ? '...' : ''})`);
    }
  } else {
    console.log('\n(No baseline — first scrape)');
  }

  const out = writePrecursorJson('evening-standard', result, {
    force: process.argv.includes('--force'),
    dryRun: !process.argv.includes('--write'),
    meta: { sourcePages: Object.values(PAGES).map((s) => 'Evening_Standard_Theatre_Award_for_' + s), minYear: MIN_YEAR },
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
