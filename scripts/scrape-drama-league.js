#!/usr/bin/env node
/**
 * Scrape Drama League Award nominations + winners from Wikipedia.
 *
 * Per-category page scraper. Drama League uses the longest nominee lists of
 * the precursors (often 10+ shows per category-year).
 *
 * Usage:
 *   node scripts/scrape-drama-league.js              # diff vs baseline
 *   node scripts/scrape-drama-league.js --write      # commit
 */

const fs = require('fs');
const path = require('path');
const { fetchHtml, parseCategoryPage } = require('./lib/precursor-category-parser');
const { writePrecursorJson, sleep, RATE_LIMIT_MS, PRECURSORS_DIR } = require('./lib/precursor-wikipedia');

const PAGES = {
  'Outstanding Production of a Musical': 'Drama_League_Award_for_Outstanding_Production_of_a_Musical',
  'Outstanding Production of a Play':    'Drama_League_Award_for_Outstanding_Production_of_a_Play',
  'Outstanding Revival of a Musical':    'Drama_League_Award_for_Outstanding_Revival_of_a_Musical',
  'Outstanding Revival of a Play':       'Drama_League_Award_for_Outstanding_Revival_of_a_Play',
  // Direction sub-categories — Wikipedia has historical coverage. Already
  // 3 yrs in source from hand-curation; this extends to ~30 years.
  'Outstanding Direction of a Musical':  'Drama_League_Award_for_Outstanding_Direction_of_a_Musical',
  'Outstanding Direction of a Play':     'Drama_League_Award_for_Outstanding_Direction_of_a_Play',
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

  const fp = path.join(PRECURSORS_DIR, 'drama-league.json');
  if (fs.existsSync(fp)) {
    const baseline = JSON.parse(fs.readFileSync(fp, 'utf8')).data;
    console.log(`\nDiff vs baseline (note: pre-${MIN_YEAR} '-' entries are preserved by merge, not dropped):`);
    for (const cat of Object.keys(PAGES)) {
      const baseYears = new Set((baseline[cat] || []).map((e) => e.year));
      const newYears = new Set(result[cat].map((e) => e.year));
      const added = [...newYears].filter((y) => !baseYears.has(y)).sort();
      const removed = [...baseYears].filter((y) => !newYears.has(y)).sort();
      console.log(`  ${cat}: +${added.join(',') || '∅'} / -${removed.join(',') || '∅'}`);
    }
  }

  const out = writePrecursorJson('drama-league', result, {
    force: FORCE,
    dryRun: !WRITE,
    meta: { sourcePages: Object.values(PAGES), minYear: MIN_YEAR },
  });
  console.log(out.written ? `\nWrote ${out.fp} (${out.newCount} entries, was ${out.oldCount})` : `\nDry run; pass --write to overwrite (${out.newCount} entries vs baseline ${out.oldCount})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
