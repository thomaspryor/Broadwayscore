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

const fs = require('fs');
const path = require('path');
const { fetchHtml, parseCategoryPage } = require('./lib/precursor-category-parser');
const { writePrecursorJson, sleep, RATE_LIMIT_MS, PRECURSORS_DIR } = require('./lib/precursor-wikipedia');

const PAGES = {
  'Outstanding New Broadway Musical':  'Outer_Critics_Circle_Award_for_Outstanding_New_Broadway_Musical',
  'Outstanding New Broadway Play':     'Outer_Critics_Circle_Award_for_Outstanding_New_Broadway_Play',
  'Outstanding Revival of a Musical':  'Outer_Critics_Circle_Award_for_Outstanding_Revival_of_a_Musical',
  'Outstanding Revival of a Play':     'Outer_Critics_Circle_Award_for_Outstanding_Revival_of_a_Play',
};

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=2014').split('=')[1],
  10,
);
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

async function main() {
  const result = {};
  for (const [category, slug] of Object.entries(PAGES)) {
    const url = `https://en.wikipedia.org/wiki/${slug}`;
    process.stdout.write(`Fetching ${slug}... `);
    try {
      const html = await fetchHtml(url);
      const entries = parseCategoryPage(html, { minYear: MIN_YEAR })
        .filter((e) => e.year >= MIN_YEAR);
      console.log(`${entries.length} year-entries`);
      result[category] = entries;
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      throw e;
    }
    await sleep(RATE_LIMIT_MS);
  }

  const fp = path.join(PRECURSORS_DIR, 'outer-critics.json');
  if (fs.existsSync(fp)) {
    const baseline = JSON.parse(fs.readFileSync(fp, 'utf8')).data;
    console.log('\nDiff vs baseline:');
    for (const cat of Object.keys(PAGES)) {
      const baseYears = new Set((baseline[cat] || []).map((e) => e.year));
      const newYears = new Set(result[cat].map((e) => e.year));
      const added = [...newYears].filter((y) => !baseYears.has(y)).sort();
      const removed = [...baseYears].filter((y) => !newYears.has(y)).sort();
      console.log(`  ${cat}: +${added.join(',') || '∅'} / -${removed.join(',') || '∅'}`);
    }
  }

  const out = writePrecursorJson('outer-critics', result, {
    force: FORCE,
    dryRun: !WRITE,
    meta: { sourcePages: Object.values(PAGES), minYear: MIN_YEAR },
  });
  console.log(out.written ? `\nWrote ${out.fp} (${out.newCount} entries, was ${out.oldCount})` : `\nDry run; pass --write to overwrite (${out.newCount} entries vs baseline ${out.oldCount})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
