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
 *   2. SUPPRESSION — scanned for EVERY show (BRO-4759: it used to cover only
 *      shows opening within ±WINDOW_DAYS, so a guard misfiring on an older show,
 *      e.g. Kramer/Fauci's Skirball entry with 5 scored reviews and 0 published,
 *      was never seen). Window shows keep the threshold below; every other show
 *      alerts only on a NEW suppression (dark, or more than the threshold hidden,
 *      above data/audit/review-suppression-baseline.json). For each scanned show,
 *      any review-text file that (a) the canonical predicate
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
// The suppression scan covers EVERY show. A guard that misfires on an older show
// (BRO-4759: Kramer/Fauci's Skirball entry held 5 scored reviews and published 0 for
// days) is invisible to a scan limited to the opening window. Shows outside the window
// alert only on a NEW suppression (see findNewOffenders); --window-only restores the
// old scope, --update-baseline rewrites the accepted set.
const windowOnly = args.includes('--window-only');
const updateBaseline = args.includes('--update-baseline');
const singleShowDeltaArg = (args.find((a) => a.startsWith('--single-show-delta=')) || '').split('=')[1];
const auditOutArg = (args.find((a) => a.startsWith('--audit-out=')) || '').split('=')[1] || null;
if (updateBaseline && (showFilter || windowOnly || singleShowDeltaArg !== undefined)) {
  // A narrowed scan sees only some shows and a different delta accepts different ones, so either
  // would rewrite the baseline from a partial picture and silently erase accepted entries.
  console.error('ERROR: --update-baseline needs the full default scan (no --show, --window-only or --single-show-delta).');
  process.exit(1);
}

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
const REVIEWS_JSON = process.env.REVIEWS_JSON || path.join(REPO_ROOT, 'data', 'reviews.json');
const SHOWS_JSON = process.env.SHOWS_JSON || path.join(REPO_ROOT, 'data', 'shows.json');
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

// Accepted suppressions for shows outside the opening window (tracked, reviewed in PRs).
// Shape: { _meta, shows: { "<showDir>": ["<accepted review-text file>", ...] } }. Pinning the FILES
// (not a count) means a new misfire cannot hide behind an old entry by swapping one file for another.
const BASELINE_PATH = process.env.REVIEW_SUPPRESSION_BASELINE
  || path.join(REPO_ROOT, 'data', 'audit', 'review-suppression-baseline.json');

function loadSuppressionBaseline() {
  let text;
  try {
    text = fs.readFileSync(BASELINE_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { shows: {} };
    throw e;
  }
  // A corrupt or merge-conflicted baseline must fail the run, not read as "nothing accepted".
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path.relative(REPO_ROOT, BASELINE_PATH)} is not valid JSON (${e.message})`);
  }
  return { shows: (raw && raw.shows) || {} };
}

function writeSuppressionBaseline(accepted) {
  const shows = {};
  for (const a of accepted) shows[a.showDir] = [...a.files].sort();
  const body = {
    _meta: {
      description: 'Shows outside the opening window whose hidden scored review files were investigated and accepted '
        + '(e.g. syndicated duplicate text, a mis-dated review the late-date guard rightly drops). '
        + 'check-review-count-drift.js alerts only on a show that is dark or hides more than the threshold AND has a hidden file NOT listed here. '
        + 'Regenerate with: node scripts/check-review-count-drift.js --update-baseline, then review the diff.',
      generatedAt: new Date().toISOString(),
    },
    shows,
  };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(body, null, 2) + '\n');
}

/**
 * Shows outside the opening window that hide scored, in-production-window reviews beyond
 * what the baseline accepts. A show is an offender when it is "dark" (publishes nothing while
 * holding at least one such file) or hides more than `delta` of them, AND at least one hidden
 * file is not in its baselined list.
 *
 * BRO-4759: with this, Kramer/Fauci's Skirball entry (4 hidden, 0 published) and Going
 * Bacharach (7 hidden, 0 published) are caught on the first daily run instead of never.
 *
 * @param {Array<{showDir: string, actual: number, suppressedCount: number, suppressed: Array<{file: string}>}>} rows
 * @param {{shows: Object<string, string[]>}} baseline
 * @param {number} delta
 * @returns {Array<{showDir: string, suppressed: number, actual: number, files: string[], newFiles: string[]}>}
 */
function findNewOffenders(rows, baseline, delta) {
  const accepted = (baseline && baseline.shows) || {};
  const out = [];
  for (const r of rows) {
    if (!r.suppressedCount) continue;
    const dark = r.actual === 0;
    if (!dark && r.suppressedCount <= delta) continue;
    const files = (r.suppressed || []).map((s) => s.file);
    const ok = new Set(Array.isArray(accepted[r.showDir]) ? accepted[r.showDir] : []);
    const newFiles = files.filter((f) => !ok.has(f));
    if (newFiles.length === 0) continue;
    out.push({ showDir: r.showDir, suppressed: r.suppressedCount, actual: r.actual, files, newFiles });
  }
  return out.sort((a, b) => b.suppressed - a.suppressed);
}

/** Baseline entries whose accepted files are no longer hidden: safe to drop with --update-baseline. */
function findStaleBaseline(rows, baseline) {
  const byShow = new Map(rows.map((r) => [r.showDir, new Set((r.suppressed || []).map((s) => s.file))]));
  const stale = [];
  for (const [showDir, files] of Object.entries((baseline && baseline.shows) || {})) {
    if (!byShow.has(showDir)) continue; // not scanned this run (e.g. dir missing): say nothing
    const now = byShow.get(showDir);
    const gone = (Array.isArray(files) ? files : []).filter((f) => !now.has(f));
    if (gone.length > 0) stale.push({ showDir, gone });
  }
  return stale;
}

/**
 * Markdown for the workflow step summary: older shows hiding scored reviews, plus baseline entries
 * that can be dropped. Tolerates audit files written before these fields existed. Returns '' when
 * there is nothing to say.
 */
function renderOffendersSummary(audit, maxRows = 25) {
  const offenders = (audit && Array.isArray(audit.newOffenders)) ? audit.newOffenders : [];
  const stale = (audit && Array.isArray(audit.staleBaseline)) ? audit.staleBaseline : [];
  const lines = [];
  if (offenders.length > 0) {
    lines.push('### Older shows hiding scored reviews');
    lines.push('');
    lines.push('These shows hold scored reviews inside their own production window that never reached reviews.json. '
      + 'Usually a guard is misfiring: check data/audit/rebuild-exclusions-SHOWID.json and fix the guard. '
      + 'If the exclusions are correct, accept them with `node scripts/check-review-count-drift.js --update-baseline` and review the diff.');
    lines.push('');
    lines.push('| Show | Hidden | Published | Not in baseline |');
    lines.push('|---|---|---|---|');
    for (const o of offenders.slice(0, maxRows)) {
      const names = (o.newFiles || []).slice(0, 3).join(', ');
      const more = (o.newFiles || []).length > 3 ? ` (+${o.newFiles.length - 3} more)` : '';
      lines.push(`| ${o.showDir} | ${o.suppressed} | ${o.actual} | ${names}${more} |`);
    }
    if (offenders.length > maxRows) lines.push(`| ...and ${offenders.length - maxRows} more | | | |`);
  }
  if (stale.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`Baseline entries no longer needed (their files are published now): ${stale.map((s) => s.showDir).join(', ')}. `
      + 'Run `node scripts/check-review-count-drift.js --update-baseline` to drop them.');
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
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
    // Most files are already published: skip the read and parse on a filename hit (the scan now
    // covers every show, so this is tens of thousands of files).
    if (entryKeys.has(file)) { scanned++; continue; }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    scanned++;
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

  const showsJsonPath = SHOWS_JSON;
  const showById = {};
  try {
    const showsData = JSON.parse(fs.readFileSync(showsJsonPath, 'utf8'));
    const showsArr = Array.isArray(showsData) ? showsData : (showsData.shows || []);
    for (const s of showsArr) if (s && s.id) showById[s.id] = s;
  } catch { /* handled just below */ }
  if (!showFilter && Object.keys(showById).length === 0) {
    // Without show metadata the production-window test rejects every file, so the scan reports 0
    // suppressed for every show and a strict run would pass while blind (BRO-4759 review).
    console.error(`ERROR: ${path.relative(REPO_ROOT, showsJsonPath)} is missing or empty: the suppression scan would be blind. Cannot run.`);
    process.exit(1);
  }

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
  } else if (windowOnly) {
    targetShows = allShowDirs.filter((id) => isInOpeningWindow(showById[id], now));
  } else {
    targetShows = allShowDirs;
  }
  const windowIds = new Set(targetShows.filter((id) => isInOpeningWindow(showById[id], now)));

  const perShow = [];
  const showsOverThreshold = [];
  let totalScanned = 0;
  for (const showDir of targetShows) {
    const { suppressed, scanned } = findSuppressedForShow(
      showDir, showById[showDir], reviewsByShow[showDir] || []
    );
    totalScanned += scanned;
    const actual = (reviewsByShow[showDir] || []).length;
    // Window shows (and the --show target) use the threshold: right at opening a few files are
    // legitimately in flight between collection and rebuild, so a small gap is tolerated there
    // (the pre-broadcast gate tightens it). Every other show is long settled, so a dark show is
    // an offender at any size; it is judged against the baseline by findNewOffenders below.
    const thresholdApplies = Boolean(showFilter) || windowIds.has(showDir);
    const overThreshold = thresholdApplies && suppressed.length > SHOW_DELTA_THRESHOLD;
    if (overThreshold) showsOverThreshold.push({ showDir, suppressed: suppressed.length, actual });
    perShow.push({ showDir, actual, scanned, suppressedCount: suppressed.length, suppressed, overThreshold });
  }

  // 2b. Shows outside the opening window: alert only on a NEW suppression -------
  // The per-show broadcast gate (--show) never consults the baseline, so a broken baseline file
  // cannot turn that gate into an exit-1 "cannot run" that the workflow treats as non-blocking.
  const baseline = showFilter ? { shows: {} } : loadSuppressionBaseline();
  const outOfWindowRows = showFilter ? [] : perShow.filter((r) => !windowIds.has(r.showDir));
  let newOffenders = findNewOffenders(outOfWindowRows, baseline, SHOW_DELTA_THRESHOLD);
  if (updateBaseline) {
    const accepted = findNewOffenders(outOfWindowRows, { shows: {} }, SHOW_DELTA_THRESHOLD);
    writeSuppressionBaseline(accepted);
    log(`Wrote ${accepted.length} accepted suppression(s) to ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
    newOffenders = []; // just accepted: the run that records them must not fail on them
  }
  const offenderIds = new Set(newOffenders.map((o) => o.showDir));
  // Informational: accepted files that are no longer hidden (fixed since); --update-baseline drops them.
  const staleBaseline = showFilter ? [] : findStaleBaseline(outOfWindowRows, baseline);

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
    log(`Shows scanned (${showFilter ? '--show' : windowOnly ? `opening window ±${WINDOW_DAYS}d` : `all, ${windowIds.size} inside the ±${WINDOW_DAYS}d opening window`}): ${targetShows.length}`);
    log(`Files scanned:          ${totalScanned}`);
    log(`Shows over threshold:   ${showsOverThreshold.length} (suppressed > ${SHOW_DELTA_THRESHOLD})`);
    log(`New offenders outside the window: ${newOffenders.length} (dark or suppressed > ${SHOW_DELTA_THRESHOLD}, with a hidden file not in the baseline)`);
    for (const o of newOffenders.slice(0, 15)) {
      log(`  ! ${o.showDir}: ${o.suppressed} scored review(s) hidden (${o.newFiles.length} not in the baseline), ${o.actual} published`);
    }
    if (staleBaseline.length > 0) {
      log(`Baseline entries no longer needed: ${staleBaseline.map((s) => s.showDir).join(', ')} (run --update-baseline to drop them)`);
    }
    log(`Orphan review-ids:      ${orphanReviews.length}`);
    for (const row of perShow) {
      if (row.suppressedCount === 0 && !showFilter) continue;
      // Out-of-window shows would flood the log: print only the ones that alert.
      if (!showFilter && !windowIds.has(row.showDir) && !offenderIds.has(row.showDir)) continue;
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
      // showsScanned keeps its meaning (the opening-window shows; the workflow labels it so);
      // allShowsScanned is the full-corpus scan.
      showsScanned: showFilter ? targetShows.length : windowIds.size,
      allShowsScanned: targetShows.length,
      filesScanned: totalScanned,
      showsOverThreshold: showsOverThreshold.length,
      newOffenders: newOffenders.length,
      // Review-text dirs with no usable production window (no shows.json entry, or no opening/previews date).
      // The scan cannot judge them, so they always report 0 hidden; this makes the blind spot visible.
      blindShows: targetShows.filter((id) => !showById[id] || !(showById[id].openingDate || showById[id].previewsStartDate)).length,
      orphanReviews: orphanReviews.length,
    },
    thresholds: {
      suppressedPerShow: SHOW_DELTA_THRESHOLD,
      windowDays: WINDOW_DAYS,
      maxAgeHours,
    },
    showsOverThreshold,
    newOffenders,
    staleBaseline,
    orphanReviews,
    // This file is committed daily: window shows (and the --show target) keep their full row, every
    // other show appears only when it alerts, so accepted and benign hidden files never churn it.
    perShow: perShow.filter((r) => (showFilter || windowIds.has(r.showDir))
      ? (r.suppressedCount > 0 || r.actual > 0)
      : offenderIds.has(r.showDir)),
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
  const suppressionBreach = showsOverThreshold.length > 0 || newOffenders.length > 0;
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
    for (const o of newOffenders.slice(0, 10)) {
      warnLog(`  ${o.showDir}: ${o.suppressed} scored review(s) inside its own production window are hidden (${o.actual} published). A guard may be misfiring: see data/audit/rebuild-exclusions-${o.showDir}.json; if the exclusions are correct, accept them with --update-baseline.`);
    }
    warnLog(`  Details: ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  }

  if (breach && strict) process.exit(2);
}

if (require.main === module) {
  try {
    if (args.includes('--render-offenders-summary')) {
      // No scan: print the markdown for the audit file a previous run wrote (the workflow's step summary).
      let audit = null;
      try { audit = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')); } catch { /* no audit yet: print nothing */ }
      process.stdout.write(renderOffendersSummary(audit));
      process.exit(0);
    }
    main();
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { findSuppressedForShow, isInOpeningWindow, normUrl, findNewOffenders, findStaleBaseline, renderOffendersSummary };
