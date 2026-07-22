#!/usr/bin/env node
/**
 * check-review-count-drift.js — is reviews.json fresh, and are any recent
 * reviews being silently suppressed?
 *
 * REDESIGNED 2026-07-11 (Notion 399637c5-416f-8161). The original design
 * compared a per-file "would rebuild include this?" probe against reviews.json
 * counts across ALL shows. That probe was a hand-maintained mirror of
 * rebuild-all-reviews.js's inclusion pipeline and drifted in both directions:
 * it reported -489 phantom staleness (circular-duplicate recovery, manual-clear
 * carve-outs it lacked), and a canonical-predicate rewrite over-included +439
 * (rebuild's in-memory date overrides it couldn't see). Mirroring a 4000-line
 * pipeline is unwinnable — see the Notion card for the full postmortem.
 *
 * What this check now asserts (each maps to a real, actionable failure):
 *
 *   1. FRESHNESS — reviews.json `_meta.lastUpdated` must be recent
 *      (rebuild-fast runs every 4h; the daily full rebuild at 4 AM UTC).
 *      Stale = the rebuild pipeline is broken or its push is failing.
 *
 *   2. SUPPRESSION (opening-night window only) — for shows opening within
 *      ±WINDOW_DAYS, any review-text file that (a) the canonical predicate
 *      review-guards.isIncludableForRebuild accepts (with filePath, so its
 *      circular-duplicate recovery runs), (b) has a valid score, (c) has a
 *      publishDate inside the show's own production window, and (d) has NO
 *      matching entry in reviews.json — is a freshly-collected review being
 *      silently suppressed. This is exactly the JCS 2026-07-09 class (4
 *      opening-night reviews invisible behind self-referential duplicate
 *      flags) WITHOUT the false alarms from decades-old flagged files (their
 *      publishDate fails the production-window test — e.g. the 2019 Broadway
 *      Beetlejuice reviews sitting in beetlejuice-west-end-2026/).
 *
 *   3. ORPHANS — reviews.json entries whose showId has no review-texts dir.
 *
 * Usage:
 *   node scripts/check-review-count-drift.js              # report (exit 0)
 *   node scripts/check-review-count-drift.js --strict     # exit 2 on breach
 *   node scripts/check-review-count-drift.js --show=ID    # single show (broadcast gate)
 *   node scripts/check-review-count-drift.js --json-only  # JSON to stdout
 *
 * The pre-broadcast gate (opening-night-broadcast.yml) runs
 * `--show=ID --single-show-delta=2 --strict`: blocked when MORE THAN 2
 * in-window scored reviews are missing from reviews.json, or when reviews.json
 * is older than SHOW_MAX_AGE_HOURS (on an opening night the poller rebuilds
 * inline — a stale derived file at send time means the pipeline is down).
 *
 * Exit codes:
 *   0 — healthy (or breach without --strict; breaches still ::warning::)
 *   1 — cannot run (missing dirs/files)
 *   2 — breach AND --strict
 */

const fs = require('fs');
const path = require('path');

const { isIncludableForRebuild, isReviewWithinOwnProductionWindow, hasValidScore } = require('./lib/review-guards');
const { generateReviewFilename } = require('./lib/review-normalization');
const { unwrapRedirectUrl } = require('./lib/scraper');

// CLI ---------------------------------------------------------
const args = process.argv.slice(2);
const showFilter = (args.find((a) => a.startsWith('--show=')) || '').split('=')[1] || null;
const jsonOnly = args.includes('--json-only');
const strict = args.includes('--strict');
const singleShowDeltaArg = (args.find((a) => a.startsWith('--single-show-delta=')) || '').split('=')[1];
const auditOutArg = (args.find((a) => a.startsWith('--audit-out=')) || '').split('=')[1] || null;

// Thresholds --------------------------------------------------
// Suppressed-review tolerance: daily sweep uses 3, the pre-broadcast gate
// tightens to 2 via --single-show-delta (flag name kept for call-site compat).
const SHOW_DELTA_THRESHOLD = singleShowDeltaArg !== undefined ? parseInt(singleShowDeltaArg, 10) : 3;
if (Number.isNaN(SHOW_DELTA_THRESHOLD) || SHOW_DELTA_THRESHOLD < 0) {
  console.error(`ERROR: --single-show-delta must be a non-negative integer, got "${singleShowDeltaArg}"`);
  process.exit(1);
}
// Shows whose openingDate is within ±WINDOW_DAYS of today get the suppression
// scan (matches opening-night-completeness-check's ±7d window).
const WINDOW_DAYS = 7;
// reviews.json freshness: rebuild-fast crons every 4h, full rebuild daily.
// --show gate allows 8h: worst healthy gap = 4h cadence + GitHub cron lag
// (routinely 30min-3h) — 6h false-blocked a broadcast in review modeling.
const GLOBAL_MAX_AGE_HOURS = 30;
const SHOW_MAX_AGE_HOURS = 8;

// Paths -------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, '..');
// Env override for unit tests (same pattern as audit-duplicate-of-url-mismatch.js)
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(REPO_ROOT, 'data', 'review-texts');
const REVIEWS_JSON = path.join(REPO_ROOT, 'data', 'reviews.json');
const DEFAULT_AUDIT_FILENAME = showFilter
  ? `review-count-drift-${showFilter}.json`
  : 'review-count-drift.json';
const OUTPUT_PATH = auditOutArg
  ? path.resolve(auditOutArg)
  : path.join(REPO_ROOT, 'data', 'audit', DEFAULT_AUDIT_FILENAME);

// Helpers -----------------------------------------------------
function log(...msg) { if (!jsonOnly) console.log(...msg); }
function warnLog(...msg) { console.warn(...msg); }

function loadReviewsJson() {
  const raw = JSON.parse(fs.readFileSync(REVIEWS_JSON, 'utf8'));
  const reviews = Array.isArray(raw) ? raw : (raw.reviews || []);
  const lastUpdated = (!Array.isArray(raw) && raw._meta && raw._meta.lastUpdated) || null;
  return { reviews, lastUpdated };
}

function normUrl(u) {
  // Google-redirect wrappers survive in some reviews.json entry URLs (SERP
  // ingest pre-04e7aa6b88); the source file holds the clean URL. Unwrap first
  // or the same review reads as two different URLs → false "suppressed".
  return (unwrapRedirectUrl(u) || '')
    .replace(/^https?:\/\/(www\.)?/, '')
    .split('?')[0]
    .replace(/[\/\s]+$/, '')
    .toLowerCase();
}

/** Is this show's opening night close enough to warrant the suppression scan? */
function isInOpeningWindow(show, now) {
  if (!show || !show.openingDate) return false;
  const open = new Date(show.openingDate).getTime();
  if (Number.isNaN(open)) return false;
  return Math.abs(now - open) <= WINDOW_DAYS * 86400000;
}

/**
 * Scan one show dir for suppressed reviews: files the canonical rebuild
 * predicate accepts, carrying a valid score, published inside the show's own
 * production window, with no corresponding reviews.json entry.
 */
function findSuppressedForShow(showDir, show, showReviews) {
  const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
  let files;
  try {
    files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
  } catch {
    return { suppressed: [], scanned: 0 };
  }

  const entryKeys = new Set();
  const entryUrls = new Set();
  for (const r of showReviews) {
    // Canonical filename generator (ship-check 2026-07-11): the writers name
    // files via normalizeOutlet/normalizeCritic (prefix stripping, alias
    // collapse, junk-byline→unknown). A naive local slug diverges on exactly
    // those names and reads a PRESENT review as suppressed → false broadcast
    // block. URL matching below remains the fallback for byline drift.
    entryKeys.add(generateReviewFilename(r.outletId, r.criticName));
    if (r.url) entryUrls.add(normUrl(r.url));
  }

  const suppressed = [];
  let scanned = 0;
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    scanned++;
    if (entryKeys.has(file)) continue;
    if (data.url && entryUrls.has(normUrl(data.url))) continue;
    // Canonical predicate WITH filePath: circular-duplicate recovery included.
    if (!isIncludableForRebuild(data, show, filePath)) continue;
    if (!hasValidScore(data)) continue;
    // Production-window test kills the false-positive class: prior-production
    // reviews with (possibly stale-cleared) flags but out-of-window dates.
    if (!isReviewWithinOwnProductionWindow(show, data.publishDate)) continue;
    suppressed.push({
      file,
      outletId: data.outletId || null,
      criticName: data.criticName || null,
      publishDate: data.publishDate || null,
      url: data.url || null,
    });
  }
  return { suppressed, scanned };
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

  const now = Date.now();
  const { reviews, lastUpdated } = loadReviewsJson();

  const reviewsByShow = {};
  for (const r of reviews) {
    if (!r || !r.showId) continue;
    (reviewsByShow[r.showId] = reviewsByShow[r.showId] || []).push(r);
  }

  const showsJsonPath = path.join(REPO_ROOT, 'data', 'shows.json');
  const showById = {};
  try {
    const showsData = JSON.parse(fs.readFileSync(showsJsonPath, 'utf8'));
    const showsArr = Array.isArray(showsData) ? showsData : (showsData.shows || []);
    for (const s of showsArr) if (s && s.id) showById[s.id] = s;
  } catch { /* shows.json missing — window scan degrades to --show only */ }

  const allShowDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();

  // 1. Freshness ---------------------------------------------
  const maxAgeHours = showFilter ? SHOW_MAX_AGE_HOURS : GLOBAL_MAX_AGE_HOURS;
  let ageHours = null;
  let freshnessBreach = false;
  if (lastUpdated) {
    ageHours = (now - new Date(lastUpdated).getTime()) / 3600000;
    freshnessBreach = ageHours > maxAgeHours;
  } else {
    // No _meta.lastUpdated — cannot assert freshness; treat as breach so a
    // regression that strips the metadata does not silently disable the check.
    freshnessBreach = true;
  }

  // 2. Suppression scan (opening window, or the --show target) -
  let targetShows;
  if (showFilter) {
    if (!allShowDirs.includes(showFilter)) {
      console.error(`ERROR: show-filter "${showFilter}" not found in review-texts/`);
      process.exit(1);
    }
    if (!showById[showFilter]) {
      // Without show metadata the production-window test rejects everything and
      // the suppression scan is silently dead — say so instead of passing quiet.
      warnLog(`::warning::show "${showFilter}" missing from shows.json — suppression scan is inert, gate reduces to freshness-only`);
    }
    targetShows = [showFilter];
  } else {
    targetShows = allShowDirs.filter((id) => isInOpeningWindow(showById[id], now));
  }

  const perShow = [];
  const showsOverThreshold = [];
  let totalScanned = 0;
  for (const showDir of targetShows) {
    const { suppressed, scanned } = findSuppressedForShow(
      showDir, showById[showDir], reviewsByShow[showDir] || []
    );
    totalScanned += scanned;
    const actual = (reviewsByShow[showDir] || []).length;
    const overThreshold = suppressed.length > SHOW_DELTA_THRESHOLD;
    if (overThreshold) showsOverThreshold.push({ showDir, suppressed: suppressed.length, actual });
    perShow.push({ showDir, actual, scanned, suppressedCount: suppressed.length, suppressed, overThreshold });
  }

  // 3. Orphans ------------------------------------------------
  const orphanReviews = [];
  const showDirSet = new Set(allShowDirs);
  for (const [showId, rs] of Object.entries(reviewsByShow)) {
    if (!showDirSet.has(showId)) orphanReviews.push({ showId, count: rs.length });
  }

  // Report ----------------------------------------------------
  if (!jsonOnly) {
    log('');
    log(`reviews.json lastUpdated: ${lastUpdated || 'MISSING'} (${ageHours != null ? ageHours.toFixed(1) + 'h ago' : 'n/a'}, max ${maxAgeHours}h)`);
    log(`Shows scanned (opening window ±${WINDOW_DAYS}d${showFilter ? ', --show' : ''}): ${targetShows.length}`);
    log(`Files scanned:          ${totalScanned}`);
    log(`Shows over threshold:   ${showsOverThreshold.length} (suppressed > ${SHOW_DELTA_THRESHOLD})`);
    log(`Orphan review-ids:      ${orphanReviews.length}`);
    for (const row of perShow) {
      if (row.suppressedCount === 0 && !showFilter) continue;
      log(`  ${row.overThreshold ? '!' : ' '} ${row.showDir}: ${row.actual} in reviews.json, ${row.suppressedCount} suppressed`);
      for (const s of row.suppressed.slice(0, 10)) {
        log(`      - ${s.file} (pub ${s.publishDate || '?'})`);
      }
    }
  }

  // Audit JSON ------------------------------------------------
  const audit = {
    generatedAt: new Date(now).toISOString(),
    summary: {
      reviewsJsonLastUpdated: lastUpdated,
      reviewsJsonAgeHours: ageHours != null ? Math.round(ageHours * 10) / 10 : null,
      freshnessBreach,
      showsScanned: targetShows.length,
      filesScanned: totalScanned,
      showsOverThreshold: showsOverThreshold.length,
      orphanReviews: orphanReviews.length,
    },
    thresholds: {
      suppressedPerShow: SHOW_DELTA_THRESHOLD,
      windowDays: WINDOW_DAYS,
      maxAgeHours,
    },
    showsOverThreshold,
    orphanReviews,
    perShow: perShow.filter((r) => r.suppressedCount > 0 || r.actual > 0),
  };

  try {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(audit, null, 2));
    log(`Wrote audit to ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  } catch (e) {
    warnLog(`WARN: failed to write audit file: ${e.message}`);
  }

  if (jsonOnly) console.log(JSON.stringify(audit, null, 2));

  // Alerts ----------------------------------------------------
  const suppressionBreach = showsOverThreshold.length > 0;
  const breach = suppressionBreach || freshnessBreach;
  if (breach) {
    warnLog('');
    warnLog('::warning title=Review pipeline drift detected::');
    if (freshnessBreach) {
      warnLog(`  reviews.json is stale: lastUpdated=${lastUpdated || 'MISSING'} (max ${maxAgeHours}h). Rebuild pipeline may be down or its push failing.`);
    }
    for (const s of showsOverThreshold.slice(0, 10)) {
      warnLog(`  ${s.showDir}: ${s.suppressed} scored in-window review(s) missing from reviews.json (has ${s.actual}).`);
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

module.exports = { findSuppressedForShow, isInOpeningWindow, normUrl };
