#!/usr/bin/env node
/**
 * Scrape WhatsOnStage Awards winners + nominees from Wikipedia.
 *
 * WOS uses per-YEAR Wikipedia pages (e.g. `2024_WhatsOnStage_Awards`), one
 * wikitable per page, with paired TH/TD columns for ~24-26 categories per
 * ceremony. Custom parser at scripts/lib/whatsonstage-parser.js.
 *
 * Output: data/precursors/whatsonstage.json keyed by category, with each
 * value an array of { year, winner, nominees, winners? } sorted by year.
 *
 * Usage:
 *   node scripts/scrape-whatsonstage.js              # dry-run diff vs baseline
 *   node scripts/scrape-whatsonstage.js --write
 *   node scripts/scrape-whatsonstage.js --min-year=2010
 *   node scripts/scrape-whatsonstage.js --force
 */

const path = require('path');
const fs = require('fs');
const { fetchWOSPage, extractYearEntries } = require('./lib/whatsonstage-parser');
const { writePrecursorJson, sleep, RATE_LIMIT_MS, PRECURSORS_DIR } = require('./lib/precursor-wikipedia');

// 2005-2007 used a "Theatregoers' Choice Awards" 3-column layout that's not
// paired-column. Default to 2008+ where structure is stable; --min-year=2005
// is allowed but yields ~3 noisy categories that the parser now filters out.
const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=2008').split('=')[1],
  10,
);
const MAX_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--max-year=')) || `--max-year=${new Date().getFullYear()}`).split('=')[1],
  10,
);

(async () => {
  // category → [{ year, winner, nominees, winners? }, ...]
  const byCategory = new Map();
  const yearsCovered = [];
  let totalEntries = 0;

  for (let year = MIN_YEAR; year <= MAX_YEAR; year++) {
    process.stdout.write(`Fetching ${year}... `);
    try {
      const html = await fetchWOSPage(year);
      const entries = extractYearEntries(html, year);
      if (entries.length === 0) {
        console.log('0 entries (page exists but no winners parsed)');
        continue;
      }
      for (const e of entries) {
        if (!byCategory.has(e.category)) byCategory.set(e.category, []);
        byCategory.get(e.category).push({
          year: e.year,
          winner: e.winner,
          nominees: e.nominees,
          ...(e.winners ? { winners: e.winners } : {}),
        });
      }
      totalEntries += entries.length;
      yearsCovered.push(year);
      console.log(`${entries.length} entries`);
    } catch (e) {
      if (e.message.includes('HTTP 404')) {
        console.log('SKIP (404 — page does not exist)');
        continue;
      }
      console.log(`ERROR: ${e.message}`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  // Sort each category by year ascending
  const result = {};
  for (const [cat, arr] of byCategory) {
    result[cat] = arr.sort((a, b) => a.year - b.year);
  }

  console.log(
    `\nScraped ${yearsCovered.length} year-pages, ${totalEntries} entries across ${byCategory.size} categories`,
  );
  console.log(`Years covered: ${yearsCovered[0]}-${yearsCovered[yearsCovered.length - 1]}`);

  const fp = path.join(PRECURSORS_DIR, 'whatsonstage.json');
  if (fs.existsSync(fp)) {
    const baseline = JSON.parse(fs.readFileSync(fp, 'utf8')).data || {};
    console.log('\nDiff vs baseline (top categories):');
    const watchCats = [
      'Best New Play',
      'Best New Musical',
      'Best Play Revival',
      'Best Musical Revival',
      'Best Off-West End Production',
    ];
    for (const cat of watchCats) {
      const newCount = (result[cat] || []).length;
      const oldCount = (baseline[cat] || []).length;
      console.log(`  ${cat}: ${newCount} entries (was ${oldCount})`);
    }
  } else {
    console.log('\n(No baseline — first scrape)');
  }

  const out = writePrecursorJson('whatsonstage', result, {
    force: process.argv.includes('--force'),
    dryRun: !process.argv.includes('--write'),
    meta: {
      sourcePages: yearsCovered.map((y) => `${y}_WhatsOnStage_Awards`),
      minYear: MIN_YEAR,
      maxYear: MAX_YEAR,
    },
  });
  console.log(
    out.written
      ? `\nWrote ${out.fp} (${out.newCount} entries, was ${out.oldCount})`
      : `\nDry run; pass --write to overwrite (${out.newCount} entries vs baseline ${out.oldCount})`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
