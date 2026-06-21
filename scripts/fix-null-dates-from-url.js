#!/usr/bin/env node
/**
 * fix-null-dates-from-url.js
 *
 * Reads data/audit/null-dates-report.json and, for every entry the audit
 * flagged as `recoverable_from_url`, extracts the publish date from the
 * review URL and writes it into the corresponding review-text JSON file.
 *
 * No LLM, no web fetches — purely deterministic URL-pattern extraction.
 *
 * Date extraction reuses the canonical extractDateFromUrl() from
 * scripts/lib/rebuild-helpers.js (same extractor the rebuild uses), so this
 * never fabricates a day that isn't actually present in the URL:
 *   - Full date in URL  -> ISO "YYYY-MM-DD"  (guardian /YYYY/mon/DD, BWW/queerty -YYYYMMDD, dash dates)
 *   - Year+month only    -> "YYYY-MM" for known outlets whose canonical URL
 *                           structure is /YYYY/MM/slug (observer.com). The
 *                           corpus already stores YM dates (blogspot pattern),
 *                           so this is an honest, supported granularity.
 *   - Year only / none   -> left null (we do NOT invent a day; see the
 *                           recover-null-dates.js notes on fake YYYY-01-01).
 *
 * Files already carrying a publishDate are left untouched (the report is a
 * point-in-time snapshot; many entries were fixed by recover-null-dates.js
 * since). Missing files (deleted reviews) are reported, not an error.
 *
 * Usage:
 *   node scripts/fix-null-dates-from-url.js              # dry run (default)
 *   node scripts/fix-null-dates-from-url.js --write      # persist changes
 *   REVIEW_TEXTS_DIR=~/broadway-review-texts node scripts/fix-null-dates-from-url.js --write
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractDateFromUrl } = require('./lib/rebuild-helpers');
const { safeWriteReview } = require('./lib/review-write-guard');

const REPO_ROOT = path.join(__dirname, '..');
const REPORT_PATH = path.join(REPO_ROOT, 'data', 'audit', 'null-dates-report.json');

// Honor REVIEW_TEXTS_DIR override (e.g. the canonical ~/broadway-review-texts
// clone) — fall back to the repo-local copy. Expand a leading ~.
function resolveReviewTextsDir() {
  const env = process.env.REVIEW_TEXTS_DIR;
  if (env && env.trim()) {
    const expanded = env.trim().replace(/^~(?=$|\/)/, os.homedir());
    return path.resolve(expanded);
  }
  return path.join(REPO_ROOT, 'data', 'review-texts');
}

const REVIEW_TEXTS_DIR = resolveReviewTextsDir();
const write = process.argv.includes('--write');

/**
 * Year+month extraction for known outlets whose canonical article URL is
 * /YYYY/MM/slug. Used only when the canonical extractor can't find a full
 * date. Returns "YYYY-MM" or null. Domain-gated on purpose — a bare
 * /YYYY/MM/ anywhere in a path is not reliably a publish date.
 */
const YM_OUTLETS = [/(?:^|\.)observer\.com$/i];

function extractYearMonthFromUrl(url) {
  if (!url) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!YM_OUTLETS.some((re) => re.test(host))) return null;
  const pathOnly = url.split('?')[0].split('#')[0];
  const m = pathOnly.match(/\/(20\d\d)\/(0[1-9]|1[0-2])\/[a-z]/i);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const report = loadJson(REPORT_PATH);
const entries = (report.categories && report.categories.recoverable_from_url) || [];

console.log(write ? '=== WRITING NULL-DATE FIXES ===' : '=== DRY RUN (pass --write to persist) ===');
console.log(`Report:        ${REPORT_PATH}`);
console.log(`Review texts:  ${REVIEW_TEXTS_DIR}`);
console.log(`Entries flagged recoverable_from_url: ${entries.length}\n`);

const stats = {
  total: entries.length,
  missingFile: 0,
  alreadyHadDate: 0,
  writtenFullDate: 0,
  writtenYearMonth: 0,
  stillNullUnrecoverable: 0,
};
const missing = [];
const unrecoverable = [];
const written = [];

for (const e of entries) {
  const filePath = path.join(REVIEW_TEXTS_DIR, e.showId, e.filename);
  if (!fs.existsSync(filePath)) {
    stats.missingFile++;
    missing.push(`${e.showId}/${e.filename}`);
    continue;
  }

  const data = loadJson(filePath);
  if (data.publishDate) {
    stats.alreadyHadDate++;
    continue;
  }

  const url = data.url || e.url;
  let date = null;
  let via = null;

  const res = extractDateFromUrl(url);
  if (res && res.date) {
    date = res.date; // "YYYY-MM-DD" or, for blogspot, "YYYY-MM"
    via = res.source;
  } else {
    const ym = extractYearMonthFromUrl(url);
    if (ym) {
      date = ym;
      via = 'url-outlet-ym';
    }
  }

  if (!date) {
    stats.stillNullUnrecoverable++;
    unrecoverable.push(`${e.showId}/${e.filename}  ${url}`);
    continue;
  }

  if (date.length === 7) stats.writtenYearMonth++;
  else stats.writtenFullDate++;
  written.push(`${e.showId}/${e.filename}  ->  ${date}  (${via})`);

  if (write) {
    data.publishDate = date;
    data.publishDateRecoveredVia = via;
    data.publishDateRecoveredFrom = 'null-dates-report';
    // Route through the guard (preserves PROTECTED_FIELDS) — direct
    // fs.writeFileSync to review-texts is blocked by the lint-workflows gate.
    safeWriteReview(filePath, data);
  }
}

console.log('--- Written (or would write) ---');
for (const w of written) console.log('  ' + w);
if (unrecoverable.length) {
  console.log('\n--- Still null (no full/partial date in URL — left untouched) ---');
  for (const u of unrecoverable) console.log('  ' + u);
}
if (missing.length) {
  console.log('\n--- Missing files (review deleted since report) ---');
  for (const m of missing) console.log('  ' + m);
}

console.log('\n=== Summary ===');
console.log(`  total flagged:            ${stats.total}`);
console.log(`  already had a date:       ${stats.alreadyHadDate}`);
console.log(`  missing file:             ${stats.missingFile}`);
console.log(`  written full date:        ${stats.writtenFullDate}`);
console.log(`  written year-month:       ${stats.writtenYearMonth}`);
console.log(`  still null (unrecoverable):${stats.stillNullUnrecoverable}`);

const remainingRecoverable = stats.stillNullUnrecoverable;
console.log(`\nRemaining recoverable-but-null: ${remainingRecoverable}`);
if (!write) {
  console.log('(dry run — re-run with --write to persist)');
}
