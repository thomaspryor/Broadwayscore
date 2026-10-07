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
async function runCategoryScraper({ pages, ceremonyName, minYear, write, force, warningThreshold = 3 }) {
  const result = {};
  const warnings = []; // {category, slug, reason}
  for (const [category, slug] of Object.entries(pages)) {
    const url = `https://en.wikipedia.org/wiki/${slug}`;
    process.stdout.write(`Fetching ${slug}... `);
    try {
      const html = await fetchHtml(url);
      const entries = parseCategoryPage(html, { minYear })
        .filter((e) => e.year >= minYear);
      // Structural contract: if this category had ≥5 entries in baseline and
      // the page now returns 0, something broke. WARN but continue scraping.
      //
      // 2026-05-18 incident: throwing here cascaded into every subsequent
      // category being skipped — DD's retired "Outstanding Actor in a Musical"
      // returned 0 entries, the throw killed the scrape, and 15+ DD 2026
      // winners were silently dropped. One bad page must not kill the whole
      // run. Baseline preserved by per-year UNION merge in precursor-wikipedia.js.
      const baselineEntries = fs.existsSync(path.join(PRECURSORS_DIR, `${ceremonyName}.json`))
        ? (JSON.parse(fs.readFileSync(path.join(PRECURSORS_DIR, `${ceremonyName}.json`), 'utf8')).data?.[category] || [])
        : [];
      if (entries.length === 0 && baselineEntries.length >= 5) {
        const reason = `structural: 0 entries, baseline had ${baselineEntries.length}`;
        // Use GitHub Actions `::warning::` annotation so the warning surfaces
        // in the workflow run UI, not just stdout. (Workflow-level escalation
        // via warnCount threshold below.)
        console.log(`::warning file=scripts/lib/per-category-precursor.js::STRUCTURAL: ${slug} returned 0 entries but baseline had ${baselineEntries.length}. Page may be restructured or category retired. Baseline preserved by UNION merge.`);
        warnings.push({ category, slug, reason });
        result[category] = [];
      } else {
        console.log(`${entries.length} year-entries`);
        result[category] = entries;
      }
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('HTTP 404') || msg.includes('HTTP 410')) {
        // 404/410: page doesn't exist (or was merged/renamed) — skip gracefully,
        // not counted as a warning (renames are normal).
        console.log(`SKIP (${msg.includes('404') ? '404' : '410'} — page not found, category may have been renamed)`);
        result[category] = [];
        continue;
      }
      // Distinguish network errors (transient, soft-continue) from parser/runtime
      // errors (likely real DOM change, escalate). fetchHtml throws with HTTP
      // status text or socket errors; parseCategoryPage throws with TypeError /
      // RangeError / 'Cannot read properties of'. If we can't tell, treat as
      // structural and let the threshold gate handle it.
      const isNetwork = /HTTP \d|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|getaddrinfo/i.test(msg);
      const isParse = /Cannot read|TypeError|RangeError|undefined is not|null is not/i.test(msg);
      if (isParse) {
        // Parse errors are exactly what the original throw existed to catch.
        // Surface as workflow-level error annotation so notify-failure fires.
        console.log(`::error file=scripts/lib/per-category-precursor.js::PARSER ERROR on ${slug}: ${msg}`);
        warnings.push({ category, slug, reason: `parser: ${msg}` });
        result[category] = [];
      } else if (isNetwork) {
        console.log(`::warning file=scripts/lib/per-category-precursor.js::NETWORK warning on ${slug}: ${msg}. Soft-continue; baseline preserved.`);
        warnings.push({ category, slug, reason: `network: ${msg}` });
        result[category] = [];
      } else {
        // Unknown error class — log + continue, but count as warning.
        console.log(`::warning file=scripts/lib/per-category-precursor.js::UNKNOWN ERROR on ${slug}: ${msg}. Soft-continue; baseline preserved.`);
        warnings.push({ category, slug, reason: `unknown: ${msg}` });
        result[category] = [];
      }
    }
    await sleep(RATE_LIMIT_MS);
  }

  // Workflow-level escalation: too many warnings means Wikipedia is broken
  // and we should fail the run rather than silently freeze on stale baseline.
  // Default threshold of 3 — a single retired category is normal, but 3+
  // simultaneous failures means a Wikipedia-wide restructure or our parser
  // broke. Sized for typical DD/OCC ceremonies (25-40 pages). Small ceremonies
  // (Critics' Circle ~5-8 pages) can pass `warningThreshold` in config to
  // raise the floor so 3 retired categories don't trip a 37.5% gate.
  //
  // EMERGENCY OVERRIDE if Wikipedia legitimately restructures multiple pages
  // at once and a code fix is days away: run via `gh workflow dispatch` with
  // ceremony=<one-ceremony> so the failure is scoped, OR temporarily raise
  // warningThreshold in the caller until source is fixed.
  const totalPages = Object.keys(pages).length;
  if (warnings.length > 0) {
    console.log(`\n${warnings.length}/${totalPages} categories produced warnings:`);
    for (const w of warnings) console.log(`  - ${w.category} (${w.slug}): ${w.reason}`);
  }
  if (warnings.length >= warningThreshold) {
    console.log(`::error::WARNING THRESHOLD EXCEEDED: ${warnings.length}/${totalPages} categories failed (threshold=${warningThreshold}). Wikipedia may have undergone broad restructure. Investigate before next run.`);
    throw new Error(`Warning threshold exceeded for ${ceremonyName}: ${warnings.length}/${totalPages} categories failed (≥${warningThreshold} triggers).`);
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
