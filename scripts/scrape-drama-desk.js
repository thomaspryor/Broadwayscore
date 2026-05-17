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

const fs = require('fs');
const path = require('path');
const { fetchHtml, parseCategoryPage } = require('./lib/precursor-category-parser');
const { writePrecursorJson, sleep, RATE_LIMIT_MS, PRECURSORS_DIR } = require('./lib/precursor-wikipedia');

const PAGES = {
  // Top categories (well-covered back to 1970s)
  'Outstanding Musical':           'Drama_Desk_Award_for_Outstanding_Musical',
  'Outstanding Play':              'Drama_Desk_Award_for_Outstanding_Play',
  'Outstanding Revival of a Musical': 'Drama_Desk_Award_for_Outstanding_Revival_of_a_Musical',
  'Outstanding Revival of a Play': 'Drama_Desk_Award_for_Outstanding_Revival_of_a_Play',
  // Sub-categories — Wikipedia has per-page coverage back to the 1970s for
  // most of these. Adding them fleshes out pre-2014 awards data for classic
  // shows (Phantom, Wicked, Les Mis, etc.) which previously only had the
  // top-category nominations after extending MIN_YEAR=1970.
  'Outstanding Director of a Musical': 'Drama_Desk_Award_for_Outstanding_Director_of_a_Musical',
  'Outstanding Director of a Play':    'Drama_Desk_Award_for_Outstanding_Director_of_a_Play',
  'Outstanding Choreography':          'Drama_Desk_Award_for_Outstanding_Choreography',
  'Outstanding Book of a Musical':     'Drama_Desk_Award_for_Outstanding_Book_of_a_Musical',
  'Outstanding Music':                 'Drama_Desk_Award_for_Outstanding_Music',
  'Outstanding Lyrics':                'Drama_Desk_Award_for_Outstanding_Lyrics',
  'Outstanding Orchestrations':        'Drama_Desk_Award_for_Outstanding_Orchestrations',
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
      throw e; // never write a partial result
    }
    await sleep(RATE_LIMIT_MS);
  }

  // Diff summary
  const fp = path.join(PRECURSORS_DIR, 'drama-desk.json');
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

  const out = writePrecursorJson('drama-desk', result, {
    force: FORCE,
    dryRun: !WRITE,
    meta: { sourcePages: Object.values(PAGES), minYear: MIN_YEAR },
  });
  console.log(out.written ? `\nWrote ${out.fp} (${out.newCount} entries, was ${out.oldCount})` : `\nDry run; pass --write to overwrite (${out.newCount} entries vs baseline ${out.oldCount})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
