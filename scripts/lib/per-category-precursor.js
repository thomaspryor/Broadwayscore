/**
 * Shared template for Wikipedia per-category award scrapers.
 *
 * All scrapers that fetch one Wikipedia page per award sub-category
 * (drama-desk, outer-critics, drama-league, and future ceremonies like
 * OBIE, Lortel, Critics' Circle) can reduce to a PAGES config + a single
 * runCategoryScraper() call.
 *
 * Usage (from a caller script):
 *   const { runCategoryScraper } = require('./lib/per-category-precursor');
 *   const PAGES = { 'Outstanding Musical': 'Drama_Desk_Award_for_...' };
 *   const MIN_YEAR = parseInt((process.argv.find(a => a.startsWith('--min-year=')) || '--min-year=2014').split('=')[1], 10);
 *   runCategoryScraper({
 *     pages: PAGES,
 *     ceremonyName: 'drama-desk',
 *     minYear: MIN_YEAR,
 *     write: process.argv.includes('--write'),
 *     force: process.argv.includes('--force'),
 *   }).catch(e => { console.error(e); process.exit(1); });
 */

const fs = require('fs');
const path = require('path');
const { fetchHtml, parseCategoryPage } = require('./precursor-category-parser');
const { writePrecursorJson, sleep, RATE_LIMIT_MS, PRECURSORS_DIR } = require('./precursor-wikipedia');

/**
 * @param {{
 *   pages: Record<string, string>,
 *   ceremonyName: string,
 *   minYear: number,
 *   write: boolean,
 *   force: boolean,
 * }} config
 */
async function runCategoryScraper({ pages, ceremonyName, minYear, write, force }) {
  const result = {};
  for (const [category, slug] of Object.entries(pages)) {
    const url = `https://en.wikipedia.org/wiki/${slug}`;
    process.stdout.write(`Fetching ${slug}... `);
    try {
      const html = await fetchHtml(url);
      const entries = parseCategoryPage(html, { minYear })
        .filter((e) => e.year >= minYear);
      // Structural contract: if this category had ≥5 entries in baseline and
      // the page now returns 0, something broke — throw so CI catches it.
      const baselineEntries = fs.existsSync(path.join(PRECURSORS_DIR, `${ceremonyName}.json`))
        ? (JSON.parse(fs.readFileSync(path.join(PRECURSORS_DIR, `${ceremonyName}.json`), 'utf8')).data?.[category] || [])
        : [];
      if (entries.length === 0 && baselineEntries.length >= 5) {
        throw new Error(`Structural assertion failed: ${slug} returned 0 entries but baseline had ${baselineEntries.length}. Wikipedia page may have changed structure.`);
      }
      console.log(`${entries.length} year-entries`);
      result[category] = entries;
    } catch (e) {
      if (e.message.includes('HTTP 404') || e.message.includes('HTTP 410')) {
        // 404/410: page doesn't exist (or was merged/renamed) — skip gracefully
        console.log(`SKIP (${e.message.includes('404') ? '404' : '410'} — page not found, category may have been renamed)`);
        result[category] = [];
      } else {
        console.log(`ERROR: ${e.message}`);
        throw e;
      }
    }
    await sleep(RATE_LIMIT_MS);
  }

  const fp = path.join(PRECURSORS_DIR, `${ceremonyName}.json`);
  if (fs.existsSync(fp)) {
    const baseline = JSON.parse(fs.readFileSync(fp, 'utf8')).data;
    console.log(`\nDiff vs baseline (note: pre-${minYear} '-' entries are preserved by merge, not dropped):`);
    for (const cat of Object.keys(pages)) {
      const baseYears = new Set((baseline[cat] || []).map((e) => e.year));
      const newYears = new Set(result[cat].map((e) => e.year));
      const added = [...newYears].filter((y) => !baseYears.has(y)).sort();
      const removed = [...baseYears].filter((y) => !newYears.has(y)).sort();
      console.log(`  ${cat}: +${added.join(',') || '∅'} / -${removed.join(',') || '∅'}`);
    }
  }

  const out = writePrecursorJson(ceremonyName, result, {
    force,
    dryRun: !write,
    meta: { sourcePages: Object.values(pages), minYear },
  });
  console.log(
    out.written
      ? `\nWrote ${out.fp} (${out.newCount} entries, was ${out.oldCount})`
      : `\nDry run; pass --write to overwrite (${out.newCount} entries vs baseline ${out.oldCount})`,
  );
}

module.exports = { runCategoryScraper };
