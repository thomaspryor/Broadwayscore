#!/usr/bin/env node
/**
 * Scrape the Pulitzer Prize for Drama winners + finalists from Wikipedia.
 *
 * Single page (https://en.wikipedia.org/wiki/Pulitzer_Prize_for_Drama) holds a
 * master wikitable with one row per ceremony year, columns: Year | Winner |
 * Author | Finalists (italic titles, comma- or break-separated). The Pulitzer
 * site itself surfaces finalists only as flat text per year, so Wikipedia is
 * the highest-fidelity source.
 *
 * Special cases:
 *   - "No award" years (1917, 1942, etc.) are skipped.
 *   - The "Drama" category is the only one we care about — the page is dedicated
 *     to it so no filtering needed.
 *
 * Usage:
 *   node scripts/scrape-pulitzer.js              # diff vs baseline
 *   node scripts/scrape-pulitzer.js --write      # commit data/precursors/pulitzer.json
 */

const fs = require('fs');
const path = require('path');
const { fetchHtml, parseCategoryPage } = require('./lib/precursor-category-parser');
const { writePrecursorJson, PRECURSORS_DIR } = require('./lib/precursor-wikipedia');

const PAGE = 'Pulitzer_Prize_for_Drama';

const MIN_YEAR = parseInt(
  (process.argv.find((a) => a.startsWith('--min-year=')) || '--min-year=2014').split('=')[1],
  10,
);
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

async function main() {
  const url = `https://en.wikipedia.org/wiki/${PAGE}`;
  process.stdout.write(`Fetching ${PAGE}... `);
  const html = await fetchHtml(url);
  console.log(`${html.length} bytes`);

  // Re-use the shared category parser (multi-table + bold-italic detection
  // landed 2026-05-16). Pulitzer page splits drama history across ~10
  // per-decade wikitables; the shared parser walks all of them. Result is
  // [{ year, winner, nominees }, ...] which we transform into Pulitzer's
  // { year, winner, finalists } shape (finalists = nominees minus winner).
  const parsed = parseCategoryPage(html, { minYear: MIN_YEAR });

  const entries = parsed
    .map(({ year, winner, nominees }) => {
      const finalists = (nominees || []).filter(
        (t) => !winner || t.toLowerCase() !== winner.toLowerCase(),
      );
      return { year, winner, finalists };
    })
    .sort((a, b) => a.year - b.year);

  console.log(`  ${entries.length} year entries (${entries.filter((e) => e.finalists.length > 0).length} with finalists)`);

  const fp = path.join(PRECURSORS_DIR, 'pulitzer.json');
  if (fs.existsSync(fp)) {
    const baseline = JSON.parse(fs.readFileSync(fp, 'utf8')).data;
    const baseYears = new Set(baseline.map((e) => e.year));
    const newYears = new Set(entries.map((e) => e.year));
    const added = [...newYears].filter((y) => !baseYears.has(y)).sort();
    const removed = [...baseYears].filter((y) => !newYears.has(y)).sort();
    console.log(`\nDiff vs baseline: +${added.join(',') || '∅'} / -${removed.join(',') || '∅'}`);
  }

  const out = writePrecursorJson('pulitzer', entries, {
    force: FORCE,
    dryRun: !WRITE,
    meta: { sourcePage: PAGE, minYear: MIN_YEAR },
  });
  console.log(out.written ? `\nWrote ${out.fp} (${out.newCount} entries, was ${out.oldCount})` : `\nDry run; pass --write to overwrite (${out.newCount} entries vs baseline ${out.oldCount})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
