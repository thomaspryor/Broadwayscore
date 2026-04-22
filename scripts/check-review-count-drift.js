#!/usr/bin/env node

/**
 * check-review-count-drift.js
 *
 * Passive drift check: expected review-text includes (source of truth) vs
 * actual entries in data/reviews.json (derived file), per show.
 *
 * Motivation (Schmigadoon 2026 postmortem finding #4): direct edits to
 * reviews.json on opening mornings and silent drops inside rebuild can
 * desynchronize the derived file from the source of truth without any signal
 * until a user notices a missing review. This script runs daily and alerts
 * when the gap crosses a threshold.
 *
 * Expected inclusion uses scripts/lib/review-text-scoreable.js — the same
 * predicate validate-data.js uses to surface silent scoring gaps — so the
 * two audits never disagree about which files rebuild "should" include.
 *
 * Usage:
 *   node scripts/check-review-count-drift.js                  # audit all shows, write json
 *   node scripts/check-review-count-drift.js --show=cats-2026 # single show, verbose
 *   node scripts/check-review-count-drift.js --json-only      # suppress per-show table
 *   node scripts/check-review-count-drift.js --strict         # exit non-zero on threshold breach
 *
 * Thresholds (alert if ANY fire):
 *   - SHOW_DELTA_THRESHOLD        single show: |expected - actual| > 3
 *   - GLOBAL_DELTA_THRESHOLD      |sum(expected) - sum(actual)| > 15
 *   - SHOW_PERCENT_THRESHOLD      single show: |delta| / expected > 0.5
 *
 * Exit codes:
 *   0 — no threshold breach (or --strict off)
 *   0 — threshold breach but --strict not set (logs warn + writes json)
 *   2 — threshold breach AND --strict
 *
 * Upper-bound caveat: review-text-scoreable.js documents the pure-predicate
 * limitation. Context-dependent rebuild guards (cross-market, syndication
 * dedup, pre-opening date, etc.) cannot be mirrored; expected will sometimes
 * over-count by 1-5 per show. That is acceptable — drift monitoring cares
 * about large, sustained deltas.
 */

const fs = require('fs');
const path = require('path');

const { wouldBeIncludedInRebuild } = require('./lib/review-text-scoreable');

// CLI ---------------------------------------------------------
const args = process.argv.slice(2);
const showFilter = (args.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;
const jsonOnly = args.includes('--json-only');
const strict = args.includes('--strict');
const verbose = args.includes('--verbose') || !!showFilter;

// Thresholds --------------------------------------------------
const SHOW_DELTA_THRESHOLD = 3;
const GLOBAL_DELTA_THRESHOLD = 15;
const SHOW_PERCENT_THRESHOLD = 0.5;

// Paths -------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data', 'review-texts');
const REVIEWS_JSON = path.join(REPO_ROOT, 'data', 'reviews.json');
const OUTPUT_PATH = path.join(REPO_ROOT, 'data', 'audit', 'review-count-drift.json');

// Helpers -----------------------------------------------------
function log(...msg) { if (!jsonOnly) console.log(...msg); }
function warnLog(...msg) { console.warn(...msg); }

function loadReviewsJson() {
  if (!fs.existsSync(REVIEWS_JSON)) {
    throw new Error(`reviews.json not found at ${REVIEWS_JSON}`);
  }
  const raw = JSON.parse(fs.readFileSync(REVIEWS_JSON, 'utf8'));
  // Handle both shapes: { reviews: [...] } and raw array
  return Array.isArray(raw) ? raw : (raw.reviews || []);
}

function buildActualCounts(reviews) {
  const counts = {};
  for (const r of reviews) {
    if (!r || !r.showId) continue;
    counts[r.showId] = (counts[r.showId] || 0) + 1;
  }
  return counts;
}

function countExpectedForShow(showDir) {
  const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
  let files;
  try {
    files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
  } catch {
    return { expected: 0, scanned: 0 };
  }
  let expected = 0;
  let scanned = 0;
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
    } catch {
      continue;
    }
    scanned++;
    if (wouldBeIncludedInRebuild(data)) expected++;
  }
  return { expected, scanned };
}

function main() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`ERROR: review-texts dir not found at ${REVIEW_TEXTS_DIR}`);
    process.exit(1);
  }
  if (!fs.existsSync(REVIEWS_JSON)) {
    console.error(`ERROR: reviews.json not found at ${REVIEWS_JSON}`);
    process.exit(1);
  }

  const reviews = loadReviewsJson();
  const actualCounts = buildActualCounts(reviews);

  const allShowDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();

  const targetShows = showFilter ? [showFilter] : allShowDirs;

  const perShow = [];
  let totalExpected = 0;
  let totalActual = 0;
  let totalScanned = 0;
  const showsOverThreshold = [];

  for (const showDir of targetShows) {
    if (showFilter && !allShowDirs.includes(showDir)) {
      console.error(`ERROR: show-filter "${showDir}" not found in review-texts/`);
      process.exit(1);
    }
    const { expected, scanned } = countExpectedForShow(showDir);
    const actual = actualCounts[showDir] || 0;
    const delta = expected - actual;
    totalExpected += expected;
    totalActual += actual;
    totalScanned += scanned;

    const absDelta = Math.abs(delta);
    const pct = expected > 0 ? absDelta / expected : 0;
    const overThreshold = absDelta > SHOW_DELTA_THRESHOLD || (expected > 0 && pct > SHOW_PERCENT_THRESHOLD);
    if (overThreshold) showsOverThreshold.push({ showDir, expected, actual, delta });

    perShow.push({ showDir, expected, actual, delta, scanned, overThreshold });
  }

  // Also flag reviews.json entries for showIds with NO review-texts dir
  // (orphan reviews — something is in the derived file that has no source).
  const orphanReviews = [];
  const showDirSet = new Set(allShowDirs);
  for (const [showId, count] of Object.entries(actualCounts)) {
    if (!showDirSet.has(showId)) orphanReviews.push({ showId, count });
  }

  const globalDelta = totalExpected - totalActual;
  const globalOverThreshold = Math.abs(globalDelta) > GLOBAL_DELTA_THRESHOLD;

  // Console table (unless --json-only) -------------------------
  if (!jsonOnly) {
    const rows = verbose ? perShow : perShow.filter((r) => r.overThreshold);
    if (rows.length > 0) {
      log('');
      log('show-id                                      | expected | actual | delta');
      log('-'.repeat(80));
      for (const r of rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 50)) {
        const marker = r.overThreshold ? '!' : ' ';
        log(
          `${marker} ${r.showDir.padEnd(42)} | ${String(r.expected).padStart(8)} | ${String(r.actual).padStart(6)} | ${String(r.delta).padStart(5)}`,
        );
      }
      if (rows.length > 50) log(`... and ${rows.length - 50} more`);
    }
    log('');
    log(`Shows scanned:          ${targetShows.length}`);
    log(`Files scanned:          ${totalScanned}`);
    log(`Total expected:         ${totalExpected}`);
    log(`Total actual:           ${totalActual}`);
    log(`Global delta:           ${globalDelta}  (threshold: ±${GLOBAL_DELTA_THRESHOLD})`);
    log(`Shows over threshold:   ${showsOverThreshold.length}`);
    log(`Orphan review-ids:      ${orphanReviews.length}`);
  }

  // Write audit JSON ------------------------------------------
  const audit = {
    generatedAt: new Date().toISOString(),
    summary: {
      showsScanned: targetShows.length,
      filesScanned: totalScanned,
      totalExpected,
      totalActual,
      globalDelta,
      showsOverThreshold: showsOverThreshold.length,
      orphanReviews: orphanReviews.length,
      globalOverThreshold,
    },
    thresholds: {
      showDelta: SHOW_DELTA_THRESHOLD,
      globalDelta: GLOBAL_DELTA_THRESHOLD,
      showPercent: SHOW_PERCENT_THRESHOLD,
    },
    showsOverThreshold,
    orphanReviews,
    perShow: perShow.filter((r) => r.expected > 0 || r.actual > 0), // drop empty rows
  };

  try {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(audit, null, 2));
    log(`Wrote audit to ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  } catch (e) {
    warnLog(`WARN: failed to write audit file: ${e.message}`);
  }

  // Alerts ----------------------------------------------------
  const breach = globalOverThreshold || showsOverThreshold.length > 0;
  if (breach) {
    warnLog('');
    warnLog('::warning title=Review-count drift detected::');
    if (globalOverThreshold) {
      warnLog(`  Global delta ${globalDelta} exceeds ±${GLOBAL_DELTA_THRESHOLD}.`);
    }
    if (showsOverThreshold.length > 0) {
      warnLog(`  ${showsOverThreshold.length} show(s) over per-show threshold (delta > ${SHOW_DELTA_THRESHOLD} OR >${SHOW_PERCENT_THRESHOLD * 100}%).`);
      for (const s of showsOverThreshold.slice(0, 10)) {
        warnLog(`    ${s.showDir}: expected=${s.expected} actual=${s.actual} delta=${s.delta}`);
      }
    }
    warnLog(`  Details: ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  }

  if (breach && strict) process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { countExpectedForShow, buildActualCounts };
