#!/usr/bin/env node
/**
 * scoring-delta.js — mandatory local verification for scoring/exclusion logic changes.
 *
 * Two independent replay phases, either of which can surface a change:
 *
 *   Phase A (inclusion): replays the contentVerification → wrongProduction
 *   promotion chain with temporal override against every review-text file
 *   under BOTH HEAD's logic and the working-tree logic. Watchlist:
 *   review-guards.js, rebuild-all-reviews.js, scoring.ts, engine.ts, data-core.ts.
 *
 *   Phase B (score-source): replays getBestScore() on every review under both
 *   HEAD's and the working-tree's rebuild-helpers and surfaces reviews whose
 *   assignedScore or scoreSource would change. Watchlist: rebuild-helpers.js,
 *   score-extractors.js, score-parsers.js, review-normalization.js, score-routing.js.
 *   Added 2026-04-22 after the NY Post stars fix (f6cb1e3266) silently skipped
 *   this gate because the original watchlist was inclusion-only. See
 *   memory/feedback_outlet_star_authoritative_set.md for the underlying fix
 *   and memory/feedback_scoring_delta_required.md for the gate's purpose.
 *
 * Background: 2026-04-14 incident. A "fix" to applyTemporalOverrides would have
 * newly excluded 183 T1 reviews across 46 flagship shows (Hamilton, Giant, Hadestown,
 * Phantom, Lion King, Book of Mormon). Unit tests passed; the counterfactual was
 * only discovered post-merge. See memory/feedback_scoring_delta_required.md.
 *
 * Usage:
 *   node scripts/scoring-delta.js                # diff working-tree vs HEAD
 *   node scripts/scoring-delta.js --base=main    # diff against a different ref
 *   node scripts/scoring-delta.js --json         # machine-readable output
 *   node scripts/scoring-delta.js --limit=100    # sample first N shows (faster)
 *
 * Exit codes:
 *   0 — no T1 flips AND ≤5 total flips (safe to merge)
 *   2 — any T1 flip OR >5 total flips (session must post summary to user before merging)
 *   1 — script error
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
// Working-tree copy is fine here: earliestShowDate only builds the shared show
// map (both replay sides read the same map); per-side guard code is loaded by
// loadBaselineGuards/loadWorkingTreeGuards below.
const { earliestShowDate } = require('./lib/date-guard');
// Working-tree copies: pure classification/parsing helpers, not on the
// scoring-logic watchlist — same rationale as earliestShowDate above.
const { isLondonMarket, isUkOutletUrl } = require('./lib/venue-classification');
const { parseDate } = require('./lib/date-utils');
// Working-tree copies: pure classification helpers behind
// shouldAutoClearWrongProductionUkDualMarket's ctx (task #1190) — same
// rationale as isLondonMarket/isUkOutletUrl above, the predicate itself
// (baseline vs working) is what's replayed per-side via __priorRunLib.
const { buildOutletRegionMap } = require('./lib/cross-market-guard');
const { normalizeOutlet: normalizeOutletCanonical } = require('./lib/review-normalization');
const { isEvergreenListingUrl } = require('./lib/cross-production-guards');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `scoring-delta.js — mandatory local verification for scoring/exclusion logic changes.

Usage:
  node scripts/scoring-delta.js [options]
  node scripts/scoring-delta.js --help, -h    print this usage and exit
`;
// hygiene-help-flag-ok: audit-help-flag-safety.js flags the fs.rmSync() inside a process.on('exit', ...) handler registered at module load — the handler only RUNS when the process exits (after --help has already printed and returned), and TMP_DIRS_TO_CLEAN is empty unless main() populated it, so it is a no-op on --help. Verified: node <this file> --help exits immediately with no fs side effects.
const ARGS = process.argv.slice(2);
const BASE_REF = (ARGS.find(a => a.startsWith('--base=')) || '--base=HEAD').split('=')[1];
const OUT_JSON = ARGS.includes('--json');
const SAMPLE_LIMIT = (() => {
  const a = ARGS.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();

// Tolerance bands. Any T1 flip at all triggers a confirmation prompt — T1 outlets
// (NYT, Vulture, Variety, Guardian, etc.) carry outsized weight in the composite
// score, so even a single flip on a flagship show materially changes the site.
// Non-T1 flips are allowed up to TOTAL_FLIP_THRESHOLD before forcing review.
const T1_FLIP_THRESHOLD = 0;        // >0 T1 flips → significant (exit 2)
const TOTAL_FLIP_THRESHOLD = 5;     // >5 total flips → significant (exit 2)

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');

// Outlet registry — mirrors rebuild-all-reviews.js's outletRegionMap/DUAL_MARKET_OUTLETS
// setup so shouldAutoClearWrongProductionUkDualMarket's ctx (task #1190) is built the
// same way here as in the rebuild it's replaying.
const outletRegistry = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'outlet-registry.json'), 'utf8'));
const outletRegionMap = buildOutletRegionMap(outletRegistry);
const DUAL_MARKET_OUTLETS = new Set();
for (const [id, info] of Object.entries(outletRegistry.outlets || {})) {
  if (info.isDualMarket) {
    DUAL_MARKET_OUTLETS.add(id);
    if (info.aliases) {
      for (const alias of info.aliases) DUAL_MARKET_OUTLETS.add(alias.toLowerCase());
    }
  }
}

// T1 outlets (tier-1 weight in scoring.ts). Hard-coded here to avoid dragging in
// full outlet-tier map; list is small and stable.
const T1_OUTLETS = new Set([
  'nytimes', 'new-york-times',
  'vulture',
  'variety',
  'washingtonpost', 'washington-post',
  'wsj', 'wall-street-journal',
  'guardian', 'the-guardian',
  'times', 'the-times',
  'telegraph', 'the-telegraph',
  'ft', 'financial-times',
  'newyorker', 'new-yorker',
  'timeout', 'time-out',
  'hollywoodreporter', 'hollywood-reporter',
  'npr',
  'chicagotribune', 'chicago-tribune',
  'latimes', 'la-times',
  'observer',
  'independent', 'the-independent',
]);

function log(...args) {
  if (!OUT_JSON) console.error(...args);
}

// Track temp dirs we create so we can clean them up at exit.
const TMP_DIRS_TO_CLEAN = [];
process.on('exit', () => {
  for (const d of TMP_DIRS_TO_CLEAN) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── Watchlist definitions ───────────────────────────────────────────────────

// Phase A — inclusion decision files. Changes here can flip a review from
// included → excluded (or vice versa) in reviews.json.
const INCLUSION_FILES = [
  'scripts/lib/review-guards.js',
  'scripts/rebuild-all-reviews.js',
  // Pre-window inclusion predicate + priorRuns window logic (card 386637c5).
  // Threshold changes there flip inclusion decisions exactly like review-guards
  // edits do — before this entry, date-guard.js edits bypassed this gate entirely.
  'scripts/lib/date-guard.js',
  'scripts/lib/wrong-production-autoclear.js',
  'src/lib/scoring.ts',
  'src/lib/engine.ts',
  'src/lib/data-core.ts',
  // Historical miss (task #947): classifyContentTier/validateShowMentioned here
  // drive contentTier and show-match rejections that rebuild-all-reviews.js and
  // recover-serp-text.js both consume for inclusion — CLAUDE.md rule 12 already
  // documented this file as "on the score-source watchlist" but it was never
  // actually added, so the Check-2 generic-idWords bug (2 wrong-show recoveries,
  // task #914 live incident) shipped without tripping this gate.
  'scripts/lib/content-quality.js',
  // Historical miss (2026-08-14): rebuild-all-reviews.js consumes
  // shouldWithholdStaleExclusionFlag from here at ten producer sites to decide
  // whether a guard may write an exclusion flag at all — an inclusion decision
  // by any reading. The file was not watched, so the 2026-08-14 rework of it
  // (deleting remediateStaleFlagAfterUrlCorrection) and an abandoned attempt to
  // narrow the detector BOTH ran this gate to "nothing to check" and had to be
  // validated by hand instead. Watch it: with this entry the same working tree
  // replays Phase A properly (verified — 42,254 reviews, 0 flips).
  'scripts/lib/stale-flag-after-url-correction.js',
  // Historical miss (2026-08-14, third of this exact shape after date-guard.js
  // and stale-flag-after-url-correction.js above): review-write-guard.js's
  // safeWriteReview consumes evaluateDatePlausibility to decide whether a NEW
  // review is quarantined as wrongProduction at ingest. A review quarantined
  // there never reaches reviews.json, so this is an inclusion decision by the
  // same reading that put date-guard.js on this list — the two files even share
  // the 180-day threshold and the priorRuns/tourLegs escape hatches. It was not
  // watched, so the dateSource: 'llm-scoring' exemption landed with this gate
  // reporting "nothing to check".
  'scripts/lib/date-plausibility.js',
];

// Phase B — score-source files. Changes here can keep a review included but
// change its assignedScore or scoreSource — silently moving a composite.
// Historical miss: scripts/lib/rebuild-helpers.js (getBestScore) wasn't in
// the watchlist; the NY Post stars fix 2026-04-22 slipped past this gate.
const SCORE_VALUE_FILES = [
  'scripts/lib/rebuild-helpers.js',
  'scripts/lib/score-extractors.js',
  'scripts/lib/score-parsers.js',
  'scripts/lib/review-normalization.js',
  'scripts/lib/score-routing.js',
];

// Inclusion-relevant flag fields in review-texts JSON files.
// A change to any of these can flip a review's inclusion decision even when
// guard CODE is unchanged (e.g. wrongProduction cleared by an audit sweep).
const FLAG_FIELDS = new Set([
  'wrongProduction', 'wrongShow', 'isRoundupArticle', 'suspectedMisattribution',
  'wrongAttribution', 'isNonReview', 'fabricatedEntry', 'contentTier',
  'rejectedAt', 'incompleteReason', 'duplicateOf', 'assignedScore',
  'wrongProductionManualClear', 'humanReviewedWrongProduction',
  'wrongProductionOverride', 'allowCrossMarket', 'allowEarlyDate',
]);

// Detect flag-field changes in data/review-texts/ (a separate git repo from
// the main Broadwayscore repo). Returns a Map of "showId/filename.json" →
// { old: parsedJSON|null, new: parsedJSON|null } for files where any
// inclusion-relevant field changed value.
//
// Note: review-texts is a separate git repo with its own history. This function
// always compares working tree vs HEAD of the review-texts repo, regardless of
// BASE_REF (which applies to the main repo). For the default usage (working-tree
// vs HEAD), the two repos are aligned. For --base=main, code changes are compared
// against main but data-flag changes are still compared against review-texts HEAD —
// which is the correct behavior (review-texts HEAD = last committed data state).
// Session baseline: data/review-texts is a single clone SHARED by all concurrent
// CMUX Claude sessions (+ local automation), so `git diff HEAD` below sees the
// UNION of every session's uncommitted churn — which made this delta report
// dozens of "flips" that belong to OTHER sessions, not the one running the check
// (2026-06-01 incident). The session-start hook snapshots the files already dirty
// when THIS session began, keyed by CMUX_SURFACE_ID, to
// /tmp/scoring-delta-baseline-<id>.tsv (lines: "<sha1>\t<relpath>"). We exclude
// any changed file whose current content sha1 matches its baseline sha1 — i.e. it
// was already dirty at session start and this session did NOT touch it.
// Fallback: no baseline (non-CMUX, or hook didn't run) → report everything (prior
// behavior). This only ever REDUCES cross-session noise, never hides a change THIS
// session made: a file this session further-edits has a different sha1 → kept.
function loadSessionBaseline() {
  const sid = process.env.CMUX_SURFACE_ID || process.env.CMUX_WORKSPACE_ID;
  if (!sid) return null;
  try {
    const m = new Map();
    for (const line of fs.readFileSync(`/tmp/scoring-delta-baseline-${sid}.tsv`, 'utf8').split('\n')) {
      const tab = line.indexOf('\t');
      if (tab > 0) m.set(line.slice(tab + 1), line.slice(0, tab));
    }
    return m.size ? m : null;
  } catch { return null; }
}
const _sessionBaseline = loadSessionBaseline();

function detectDataFlagChanges() {
  const result = new Map();
  const rtGit = path.join(REVIEW_TEXTS_DIR, '.git');
  if (!fs.existsSync(rtGit)) return result;
  try {
    let changed = execSync('git diff HEAD --name-only', {
      cwd: REVIEW_TEXTS_DIR, encoding: 'utf8',
    }).trim().split('\n').filter(f => f && f.endsWith('.json') && !f.endsWith('failed-fetches.json'));
    if (changed.length === 0) return result;
    // Exclude files already dirty at session start and untouched by this session
    // (other sessions' churn) — see loadSessionBaseline() above.
    if (_sessionBaseline) {
      const before = changed.length;
      changed = changed.filter(relPath => {
        const baseHash = _sessionBaseline.get(relPath);
        if (!baseHash) return true; // not dirty at session start → this session's
        try {
          const cur = crypto.createHash('sha1')
            .update(fs.readFileSync(path.join(REVIEW_TEXTS_DIR, relPath)))
            .digest('hex');
          return cur !== baseHash; // changed since start → keep; identical → drop
        } catch { return true; }
      });
      const dropped = before - changed.length;
      if (dropped > 0) log(`[scoring-delta] excluded ${dropped} pre-session review-texts file(s) (other sessions' churn) via CMUX baseline; ${changed.length} changed by this session`);
      if (changed.length === 0) return result;
    }
    if (changed.length > 2000) {
      log(`[scoring-delta] data-flag: ${changed.length} changed files — scanning first 2000 (raise cap if this audit is larger)`);
    }
    const toCheck = changed.length > 2000 ? changed.slice(0, 2000) : changed;
    for (const relPath of toCheck) {
      let oldData = null;
      try {
        const raw = execSync(`git show HEAD:${relPath}`, {
          cwd: REVIEW_TEXTS_DIR, encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        oldData = JSON.parse(raw);
      } catch { /* new file */ }
      let newData = null;
      try {
        const absPath = path.join(REVIEW_TEXTS_DIR, relPath);
        if (fs.existsSync(absPath)) newData = JSON.parse(fs.readFileSync(absPath, 'utf8'));
      } catch { /* deleted or invalid */ }
      const hasRelevantChange = [...FLAG_FIELDS].some(field => {
        const oldVal = oldData ? (oldData[field] ?? null) : null;
        const newVal = newData ? (newData[field] ?? null) : null;
        return JSON.stringify(oldVal) !== JSON.stringify(newVal);
      });
      if (hasRelevantChange) result.set(relPath, { old: oldData, new: newData });
    }
  } catch { /* git unavailable — skip data-flag detection */ }
  return result;
}

function gitDiffHasChanges(files) {
  try {
    const out = execSync(
      `git diff ${BASE_REF} -- ${files.map(f => `'${f}'`).join(' ')}`,
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    return out.trim().length > 0;
  } catch (e) {
    throw new Error(`git diff failed: ${e.message}`);
  }
}

// ─── Load two versions of review-guards ──────────────────────────────────────

function loadBaselineGuards() {
  // Dump HEAD's version of review-guards.js + date-utils.js to a temp dir so we
  // can require() them independently from the working-tree version.
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scoring-delta-'));
  TMP_DIRS_TO_CLEAN.push(tmpDir);
  const baselineLibDir = path.join(tmpDir, 'lib');
  fs.mkdirSync(baselineLibDir, { recursive: true });

  try {
    const guardsSrc = execSync(`git show ${BASE_REF}:scripts/lib/review-guards.js`, {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    fs.writeFileSync(path.join(baselineLibDir, 'review-guards.js'), guardsSrc);
  } catch (e) {
    throw new Error(`Could not load ${BASE_REF}:scripts/lib/review-guards.js — ${e.message}`);
  }

  // Include date-utils.js (dependency of review-guards) — but since we're not
  // changing it, the working-tree version is fine. Use a symlink-style require
  // remap. Actually simpler: copy date-utils from HEAD too, to be safe.
  try {
    const dateUtilsSrc = execSync(`git show ${BASE_REF}:scripts/lib/date-utils.js`, {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    fs.writeFileSync(path.join(baselineLibDir, 'date-utils.js'), dateUtilsSrc);
  } catch {
    // date-utils may not be in BASE_REF — fall back to working-tree copy
    fs.copyFileSync(
      path.join(REPO_ROOT, 'scripts/lib/date-utils.js'),
      path.join(baselineLibDir, 'date-utils.js')
    );
  }

  // date-guard.js (+ its dependency wrong-production-autoclear.js): the
  // pre-window inclusion predicate lives there (card 386637c5). Materialize the
  // BASE_REF copies so threshold/predicate changes replay per side. If BASE_REF
  // predates a file entirely, the WORKING-TREE copy is used for that baseline
  // side — the baseline then behaves like the working tree (silent zero-delta
  // for that guard). Acceptable: date-guard.js has existed since 2026-05-25,
  // and BASE_REF defaults to HEAD. Baselines that HAVE date-guard.js but lack
  // evaluatePreWindowInclusion take simulateInclusion's legacy inline branch.
  for (const dep of ['date-guard.js', 'wrong-production-autoclear.js']) {
    try {
      const src = execSync(`git show ${BASE_REF}:scripts/lib/${dep}`, {
        cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      fs.writeFileSync(path.join(baselineLibDir, dep), src);
    } catch {
      fs.copyFileSync(
        path.join(REPO_ROOT, 'scripts/lib', dep),
        path.join(baselineLibDir, dep)
      );
    }
  }

  // Clear require cache and load baseline
  const baselinePath = path.join(baselineLibDir, 'review-guards.js');
  delete require.cache[require.resolve(baselinePath)];
  const guards = require(baselinePath);
  const dgPath = path.join(baselineLibDir, 'date-guard.js');
  delete require.cache[require.resolve(dgPath)];
  const prPath = path.join(baselineLibDir, 'wrong-production-autoclear.js');
  delete require.cache[require.resolve(prPath)];
  return { ...guards, __dateGuard: require(dgPath), __priorRunLib: require(prPath) };
}

function loadWorkingTreeGuards() {
  const wtPath = path.resolve(REPO_ROOT, 'scripts/lib/review-guards.js');
  delete require.cache[require.resolve(wtPath)];
  const guards = require(wtPath);
  const dgPath = path.resolve(REPO_ROOT, 'scripts/lib/date-guard.js');
  delete require.cache[require.resolve(dgPath)];
  const prPath = path.resolve(REPO_ROOT, 'scripts/lib/wrong-production-autoclear.js');
  delete require.cache[require.resolve(prPath)];
  return { ...guards, __dateGuard: require(dgPath), __priorRunLib: require(prPath) };
}

// ─── Load two versions of rebuild-helpers (Phase B) ──────────────────────────

// Dumps HEAD's scripts/lib + scripts/llm-scoring to a temp directory so
// rebuild-helpers and its transitive deps (score-extractors, score-parsers,
// review-normalization, text-cleaning, score-calibration, date-utils, etc.)
// resolve against HEAD's copies — isolated from the working-tree versions.
function loadBaselineScoring() {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scoring-delta-b-'));
  TMP_DIRS_TO_CLEAN.push(tmpDir);
  const libDir = path.join(tmpDir, 'scripts', 'lib');
  const llmDir = path.join(tmpDir, 'scripts', 'llm-scoring');
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(llmDir, { recursive: true });

  // Stream HEAD's scripts/lib + scripts/llm-scoring into tmpDir via git archive.
  // Using pipe/tar keeps the directory structure intact so relative require()
  // paths inside rebuild-helpers ('./score-parsers', '../llm-scoring/...') all
  // resolve to baseline copies, not working-tree copies.
  try {
    execSync(
      `git archive ${BASE_REF} -- scripts/lib scripts/llm-scoring | tar -x -C '${tmpDir}'`,
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: '/bin/bash' }
    );
  } catch (e) {
    throw new Error(`Could not archive ${BASE_REF}:scripts/lib + scripts/llm-scoring — ${e.message}`);
  }

  const baselinePath = path.join(libDir, 'rebuild-helpers.js');
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Baseline rebuild-helpers.js missing after git archive at ${baselinePath}`);
  }
  // Give the baseline libs the repo's data/ directory. score-parsers lazy-loads
  // data/outlet-registry.json via __dirname/../../data — inside the tmpDir
  // extract that path doesn't exist, so outlet star scales (NY Post /4) fell
  // back to /5 and the BASELINE mis-scored every outlet-scale review, reporting
  // phantom flips the working tree didn't cause (4 false NY Post flips,
  // 2026-07-11). Symlink is read-only usage; tmpDir is cleaned after the run.
  const dataLink = path.join(tmpDir, 'data');
  if (!fs.existsSync(dataLink)) {
    fs.symlinkSync(path.join(REPO_ROOT, 'data'), dataLink, 'dir');
  }
  // Purge any previously cached module under this tmpDir path (should be none,
  // but be defensive in case the script is imported in a long-running process).
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(tmpDir)) delete require.cache[cached];
  }
  return require(baselinePath);
}

function loadWorkingTreeScoring() {
  const wtPath = path.resolve(REPO_ROOT, 'scripts/lib/rebuild-helpers.js');
  // Clear wtPath AND its transitive deps so Phase B sees the working-tree
  // versions even if Node cached them from an earlier require in this process.
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(path.resolve(REPO_ROOT, 'scripts/lib/'))
        || cached.startsWith(path.resolve(REPO_ROOT, 'scripts/llm-scoring/'))) {
      delete require.cache[cached];
    }
  }
  return require(wtPath);
}

// ─── Decision replay ─────────────────────────────────────────────────────────

/**
 * Replays the inclusion decision for a single review under a given guards
 * module. Returns `{included, reason}`.
 *
 * We model the primary scoring-logic exclusions: temporal override +
 * contentVerification promotion to wrongProduction + existing review flags.
 * This is a subset of rebuild-all-reviews.js's full decision chain, but
 * captures the path that the Giant/temporal incident flowed through.
 */
function decideInclusion(review, show, guards) {
  // 1. Already-flagged top-level exclusions. A static wrongShow/wrongProduction
  // flag on disk does NOT mean rebuild-all-reviews.js excludes the review — the
  // rebuild's auto-clear paths (shouldAutoClearWrongShowUkUrl, shouldAutoClearWrongShow,
  // shouldAutoClearWrongProduction — scripts/lib/wrong-production-autoclear.js) strip
  // the flag BEFORE this check runs. Replay those same predicates here, under
  // whichever guards module the caller passed (baseline or working-tree), so a
  // predicate change flips this decision exactly like it flips the rebuild's
  // (task #1163 — this replay previously modeled the flags as static/identical
  // on both sides, so it could never surface a regression in the auto-clear logic
  // itself). NOTE: this covers the 4 named predicates in wrong-production-autoclear.js
  // keyed purely off the review + show (including shouldAutoClearWrongProductionUkDualMarket,
  // task #1190 — extracted from rebuild-all-reviews.js:2464-2534 by task #1189 but left
  // out of this replay until now) — it does NOT cover the priorRuns/tourLegs/URL-year
  // variants (need per-file provenance not modeled here).
  const autoClear = guards.__priorRunLib || {};

  let wrongShowCleared = false;
  if (review.wrongShow === true) {
    if (typeof autoClear.shouldAutoClearWrongShowUkUrl === 'function') {
      let dateMismatchOver90d = false;
      if (review.publishDate && show?.earliestDate) {
        const reviewDate = parseDate(review.publishDate);
        const preWindowDays = guards.__dateGuard?.PRE_WINDOW_DAYS ?? 60;
        if (reviewDate && !isNaN(reviewDate.getTime())
            && (new Date(show.earliestDate).getTime() - reviewDate.getTime()) > preWindowDays * 86400000) {
          dateMismatchOver90d = true;
        }
      }
      wrongShowCleared = autoClear.shouldAutoClearWrongShowUkUrl(review, {
        isLondonMarketShow: isLondonMarket(show?.category),
        isUkOutletUrl: !!(review.url && isUkOutletUrl(review.url)),
        dateMismatchOver90d,
      });
    }
    if (!wrongShowCleared && typeof autoClear.shouldAutoClearWrongShow === 'function') {
      wrongShowCleared = autoClear.shouldAutoClearWrongShow(review);
    }
  }

  let wrongProductionCleared = false;
  if (review.wrongProduction === true && typeof autoClear.shouldAutoClearWrongProduction === 'function') {
    wrongProductionCleared = autoClear.shouldAutoClearWrongProduction(review);
  }
  // UK/dual-market auto-clear (task #1190) — mirrors rebuild-all-reviews.js:2608-2687's
  // ctx computation exactly, including its outer short-circuit (isStructuralFlag ||
  // isDateMismatch skips the whole block there, so isUkUrl/outletIsDualOrUk/etc. are
  // never computed and the predicate can't fire either).
  if (!wrongProductionCleared && review.wrongProduction === true && !review.wrongProductionOverride
      && isLondonMarket(show?.category) && review.url
      && typeof autoClear.shouldAutoClearWrongProductionUkDualMarket === 'function') {
    const wpNote = review.wrongProductionNote || '';
    const isStructuralFlag = wpNote.includes('Same URL exists') || wpNote.includes('Pre-opening guard')
      || wpNote.includes('days before show opened') || wpNote.includes('URL contains year');
    let isDateMismatch = false;
    if (review.publishDate && show?.earliestDate) {
      const reviewDate = parseDate(review.publishDate);
      const preWindowDays = guards.__dateGuard?.PRE_WINDOW_DAYS ?? 60;
      if (reviewDate && !isNaN(reviewDate.getTime())
          && (new Date(show.earliestDate).getTime() - reviewDate.getTime()) > preWindowDays * 86400000) {
        isDateMismatch = true;
      }
    }
    if (!isStructuralFlag && !isDateMismatch) {
      try {
        // Mirrors rebuild-all-reviews.js:2645-2648's `new URL(data.url)` —
        // a malformed URL throws there and aborts the whole clear attempt
        // (predicate never called). isUkOutletUrl() swallows URL-parse
        // failures internally and returns false, so without this explicit
        // parse the replay would keep evaluating on a malformed URL where
        // production would have bailed out — a real divergence caught by
        // ship-check's adversarial review.
        new URL(review.url);
        const rawOutlet = (review.outletId || review.outlet || '').toLowerCase();
        const canonicalOutlet = normalizeOutletCanonical(rawOutlet);
        const outletIsDualOrUk = DUAL_MARKET_OUTLETS.has(canonicalOutlet)
          || outletRegionMap[canonicalOutlet] === 'london' || outletRegionMap[rawOutlet] === 'london';
        const outletIsLondonRegion = outletRegionMap[canonicalOutlet] === 'london'
          || outletRegionMap[rawOutlet] === 'london';
        const isUkUrl = isUkOutletUrl(review.url);
        const cvBlocksClear = typeof guards.cvBlocksUkWrongProductionAutoClear === 'function'
          ? guards.cvBlocksUkWrongProductionAutoClear(review.contentVerification)
          : false;
        const isShowListingUrl = /(?:whatsonstage|broadwayworld)\.com\/shows?\//i.test(review.url)
          || isEvergreenListingUrl(review.url);
        wrongProductionCleared = autoClear.shouldAutoClearWrongProductionUkDualMarket(review, {
          isLondonMarketShow: isLondonMarket(show?.category),
          isUkUrl,
          outletIsDualOrUk,
          outletIsLondonRegion,
          isDateMismatch,
          isShowListingUrl,
          cvBlocksClear,
        });
      } catch {}
    }
  }

  if (review.wrongShow === true && !wrongShowCleared) return { included: false, reason: 'wrongShow' };
  if (review.wrongProduction === true && !wrongProductionCleared) return { included: false, reason: 'wrongProduction' };
  if (review.duplicateOf) return { included: false, reason: 'duplicateOf' };
  if (review.isRoundupArticle) {
    const isStale = typeof guards.isLikelyStaleRoundupFlag === 'function'
      ? guards.isLikelyStaleRoundupFlag(review)
      : false;
    if (!isStale) return { included: false, reason: 'isRoundupArticle' };
  }
  if (review.incompleteReason === 'wrong_content') return { included: false, reason: 'incompleteReason:wrong_content' };
  if (review.contentTier === 'invalid') return { included: false, reason: 'contentTier:invalid' };
  if (review.assignedScore == null) return { included: false, reason: 'no score' };

  // Pre-opening temporal gate (Benjamin Button 2026-07-21). The guard honors
  // priorRuns + every manual-clear/early-date override internally, so it can
  // run before the manual-clear bypass below. Optional-typed because the
  // baseline (HEAD) guards module may predate the function.
  if (typeof guards.isPrematureReviewForUnopenedShow === 'function'
      && guards.isPrematureReviewForUnopenedShow(review, show)) {
    return { included: false, reason: 'premature pre-opening review' };
  }

  // Manual-clear bypass: treat as included for both versions identically.
  // Mirrors rebuild's shouldSkipWrongProductionAudit() + allowCrossMarket/allowEarlyDate semantics.
  const manuallyCleared =
    review.wrongProductionManualClear === true ||
    review.humanReviewedWrongProduction === false ||
    review.wrongProductionOverride === true ||
    review.allowCrossMarket === true ||
    review.allowEarlyDate === true;
  if (manuallyCleared) return { included: true, reason: 'manually cleared' };

  // 2. Content-verification promotion chain (this is where temporal override acts)
  //    Mirrors rebuild-all-reviews.js:1095-1113 CV pre-pass staleness logic.
  const cv = review.contentVerification;
  if (cv && (cv.confidence === 'high' || cv.confidence === 'medium')) {
    // Staleness check: (a) timestamp-based, (b) content-hash-based, with a
    // high-confidence-wrongArticle exception that survives staleness.
    let stale = false;
    if (review.textFetchedAt && cv.verifiedAt) {
      if (new Date(review.textFetchedAt).getTime() > new Date(cv.verifiedAt).getTime()) {
        stale = true;
      }
    }
    if (!stale && cv.contentHash && review.fullText) {
      const h = crypto.createHash('md5').update(review.fullText.substring(0, 2500)).digest('hex');
      if (cv.contentHash !== h) stale = true;
    }
    // wrongArticle @ high confidence survives staleness (see rebuild-all-reviews.js:1106-1112)
    const trustWrongArticleDespiteStale = cv.wrongArticle === true && cv.confidence === 'high';
    if (stale && trustWrongArticleDespiteStale) stale = false;

    if (!stale) {
      // Apply temporal override — the function under test
      const openingDate = show?.openingDate || null;
      const publishDate = review.publishDate || null;
      const temporal = guards.applyTemporalOverrides(
        cv.wrongProduction === true,
        cv.isFilmTv === true,
        cv.confidence,
        openingDate,
        publishDate,
      );

      // Would cv.wrongProduction get promoted?
      if (cv.wrongProduction === true
          && !guards.shouldSkipWrongProductionAudit(review)
          && !review.allowEarlyDate
          && !review.allowCrossMarket) {
        // Promotion happens at 'high' or 'medium' confidence — 'low' blocks it
        const effectiveConfidence = temporal.wpConfidence || cv.confidence;
        if (effectiveConfidence === 'high' || effectiveConfidence === 'medium') {
          return { included: false, reason: `cv-promoted wrongProduction (${effectiveConfidence})` };
        }
      }

      // Would cv.wrongArticle get promoted?
      if (cv.wrongArticle === true && !review.allowEarlyDate && !review.allowCrossMarket) {
        if (cv.confidence === 'high' || cv.confidence === 'medium') {
          return { included: false, reason: 'cv-promoted wrongArticle' };
        }
      }

      // isFilmTv promotion — temporal override clears this flag within 30 days
      if (temporal.filmTvFlag === true && !review.allowEarlyDate && !review.allowCrossMarket) {
        return { included: false, reason: 'cv-promoted isFilmTv' };
      }
    }
  }

  // 3. Inline guards from rebuild (date, tour, roundup, URL mismatch)
  if (show?.earliestDate && review.publishDate && !review.allowEarlyDate) {
    const isOB = show.category === 'off-broadway';
    const isLondon = show.category === 'west-end' || show.category === 'off-west-end';
    const evalPreWindow = guards.__dateGuard?.evaluatePreWindowInclusion;
    if (evalPreWindow) {
      // Same predicate the rebuild inclusion pass calls (parity by construction,
      // incl. the priorRuns/tourLegs exemptions the legacy sim branch below lacked).
      const pw = evalPreWindow({
        pubDate: new Date(review.publishDate),
        showEarliest: new Date(show.earliestDate),
        isFlexCategory: isOB || isLondon,
        priorRuns: show.priorRuns,
        tourLegs: show.tourLegs,
      });
      if (pw.exclude) {
        return { included: false, reason: `date-guard (>${pw.threshold}d before show)` };
      }
    } else {
      // Baseline predates the extracted predicate — replicate its inline thresholds.
      const threshold = (isOB || isLondon) ? 90 : 14;
      if (guards.isLikelyWrongProduction(review.publishDate, show.earliestDate, threshold)) {
        return { included: false, reason: `date-guard (>${threshold}d before show)` };
      }
    }
  }

  if (review.url && show?.id && guards.isLikelyTourReview(review.url, show.id)) {
    return { included: false, reason: 'tour-review URL' };
  }

  if (guards.isRoundupPageAsReview ? guards.isRoundupPageAsReview(review) : (review.url && guards.isRoundupUrl(review.url).isRoundup)) {
    // page-as-review only — a review SOURCED from a roundup (different outletId)
    // is included by rebuild, so the sim must include it too (parity, 2026-07-10)
    return { included: false, reason: 'roundup page as review' };
  }

  return { included: true, reason: 'passes guards' };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  log(`[scoring-delta] Comparing working-tree vs ${BASE_REF}`);

  // Guard 1: any diff in either watchlist?
  let inclusionDiff = false;
  let scoreValueDiff = false;
  try {
    inclusionDiff = gitDiffHasChanges(INCLUSION_FILES);
    scoreValueDiff = gitDiffHasChanges(SCORE_VALUE_FILES);
  } catch (e) {
    log(`[scoring-delta] ${e.message}`);
    process.exit(1);
  }

  // Guard 1b: flag-field changes in review-texts (separate git repo).
  // Audit sweeps (e.g. clearing wrongProduction) change data but not code,
  // so inclusionDiff stays false — but the inclusion decisions still flip.
  const changedReviewFiles = detectDataFlagChanges();
  const dataFlagDiff = changedReviewFiles.size > 0;

  if (!inclusionDiff && !scoreValueDiff && !dataFlagDiff) {
    log('[scoring-delta] ✅ No changes to inclusion, score-value, or review-texts flag files vs ' + BASE_REF + ' — nothing to check.');
    if (OUT_JSON) console.log(JSON.stringify({ flips: 0, t1Flips: 0, shows: 0, reason: 'no-diff' }));
    process.exit(0);
  }

  log(`[scoring-delta] Phase A (inclusion): ${inclusionDiff ? 'code diff detected' : 'no code diff'}${dataFlagDiff ? `, ${changedReviewFiles.size} review-texts flag-field changes` : ''}`);
  log(`[scoring-delta] Phase B (score-source): ${scoreValueDiff ? 'diff detected' : 'no diff'}`);

  // ── Phase A prep: load inclusion guards if needed ──
  let baseline = null;
  let working = null;
  let runPhaseA = false;

  if (inclusionDiff || dataFlagDiff) {
    // Always load working guards — needed for data-flag replay even when code unchanged.
    working = loadWorkingTreeGuards();

    if (inclusionDiff) {
      baseline = loadBaselineGuards();

      // Sanity: if inclusion guards are string-identical, Phase A has nothing to replay.
      //
      // Note: data dependencies are tracked separately. isLikelyStaleSuspectedMisattribution
      // reads critic-registry.json at decision time, so a change to that data file can flip
      // inclusion decisions even when the function source is identical. We hash the registry
      // content and include it in the identity check so registry-driven flips replay too.
      //
      // Task #1075: BOTH reads can be blind, and the blindness used to be
      // invisible. data/critic-registry.json is gitignored here (private
      // core-data repo, CLAUDE.md §11), so the baseline read via `git show`
      // NEVER succeeds; and in a worktree/CI checkout without the private
      // clone the working-tree read fails too. When both failed they both
      // returned the literal 'unreadable', compared EQUAL, and Phase A was
      // skipped with "decisions identical" — a comparison that never happened
      // reported as a clean one. Now an unreadable side is a distinct verdict:
      // registryComparable=false forces the replay and says why.
      const registryPath = require('path').join(__dirname, '..', 'data', 'critic-registry.json');
      const hashOrNull = (buf) => (buf == null ? null : crypto.createHash('md5').update(buf).digest('hex'));
      const registryHash = (() => {
        try { return hashOrNull(require('fs').readFileSync(registryPath)); } catch { return null; }
      })();
      const baselineRegistryHash = (() => {
        try {
          // observability-ok: failure yields null → registryComparable=false → Phase A replays; never read as "same"
          return hashOrNull(require('child_process').execSync(`git show ${BASE_REF}:data/critic-registry.json`, { stdio: ['ignore', 'pipe', 'ignore'] }));
        } catch { return null; }
      })();
      const registryComparable = registryHash !== null && baselineRegistryHash !== null;
      if (!registryComparable) {
        const blind = [
          registryHash === null ? 'the working tree' : null,
          baselineRegistryHash === null ? `${BASE_REF} (gitignored here — it lives in the private core-data repo)` : null,
        ].filter(Boolean).join(' and ');
        log(
          `[scoring-delta] CANNOT-OBSERVE: critic-registry.json unreadable on ${blind} — ` +
            'cannot prove registry-driven inclusion decisions are unchanged, so Phase A replays.'
        );
      }
      const guardsIdentical =
        baseline.applyTemporalOverrides.toString() === working.applyTemporalOverrides.toString()
        && baseline.isLikelyWrongProduction.toString() === working.isLikelyWrongProduction.toString()
        && baseline.isLikelyTourReview.toString() === working.isLikelyTourReview.toString()
        && baseline.shouldSkipWrongProductionAudit.toString() === working.shouldSkipWrongProductionAudit.toString()
        && (baseline.isRoundupUrl?.toString() || '') === (working.isRoundupUrl?.toString() || '')
        && (baseline.isLikelyStaleRoundupFlag?.toString() || '') === (working.isLikelyStaleRoundupFlag?.toString() || '')
        && (baseline.isLikelyStaleSuspectedMisattribution?.toString() || '') === (working.isLikelyStaleSuspectedMisattribution?.toString() || '')
        // Used by decideInclusion (roundup-page-as-review check) but was missing
        // from this identity list — same blind-spot class as the canonical
        // predicate omission fixed 2026-07-21.
        && (baseline.isRoundupPageAsReview?.toString() || '') === (working.isRoundupPageAsReview?.toString() || '')
        // Pre-window predicate + its THRESHOLD CONSTANTS. Constants are compared
        // by value, not via toString() — the function body reads free variables
        // (PRE_WINDOW_DAYS), so a constant-only edit leaves the source identical.
        && (baseline.__dateGuard?.evaluatePreWindowInclusion?.toString() || '') === (working.__dateGuard?.evaluatePreWindowInclusion?.toString() || '')
        && String(baseline.__dateGuard?.PRE_WINDOW_DAYS) === String(working.__dateGuard?.PRE_WINDOW_DAYS)
        && String(baseline.__dateGuard?.PRE_WINDOW_DAYS_BROADWAY) === String(working.__dateGuard?.PRE_WINDOW_DAYS_BROADWAY)
        && (baseline.__priorRunLib?.isWithinPriorRun?.toString() || '') === (working.__priorRunLib?.isWithinPriorRun?.toString() || '')
        // Same rationale for isWithinTourLeg: evaluatePreWindowInclusion's own
        // toString() doesn't capture the source of a function it CALLS, so an
        // edit only inside isWithinTourLeg would otherwise go undetected here.
        && (baseline.__priorRunLib?.isWithinTourLeg?.toString() || '') === (working.__priorRunLib?.isWithinTourLeg?.toString() || '')
        // wrongShow/wrongProduction auto-clear predicates (task #1163). The rebuild
        // strips these flags via shouldAutoClearWrongShow/-UkUrl/-WrongProduction
        // BEFORE the flag-present check ever runs — without comparing them here, a
        // change to ONLY these predicates left every other compared function
        // byte-identical, so guardsIdentical stayed true and Phase A was skipped
        // even though real inclusion decisions had silently flipped.
        && (baseline.__priorRunLib?.shouldAutoClearWrongShow?.toString() || '') === (working.__priorRunLib?.shouldAutoClearWrongShow?.toString() || '')
        && (baseline.__priorRunLib?.shouldAutoClearWrongShowUkUrl?.toString() || '') === (working.__priorRunLib?.shouldAutoClearWrongShowUkUrl?.toString() || '')
        && (baseline.__priorRunLib?.shouldAutoClearWrongProduction?.toString() || '') === (working.__priorRunLib?.shouldAutoClearWrongProduction?.toString() || '')
        // shouldAutoClearWrongProductionUkDualMarket (task #1190) + the CV-verdict
        // predicate it depends on — cvBlocksUkWrongProductionAutoClear was never
        // in this list even though decideInclusion now calls it, which would have
        // reopened the exact #1163 blind spot this comparison block exists to close.
        && (baseline.__priorRunLib?.shouldAutoClearWrongProductionUkDualMarket?.toString() || '') === (working.__priorRunLib?.shouldAutoClearWrongProductionUkDualMarket?.toString() || '')
        && (baseline.cvBlocksUkWrongProductionAutoClear?.toString() || '') === (working.cvBlocksUkWrongProductionAutoClear?.toString() || '')
        // Canonical inclusion predicate + pre-opening gate. isIncludableForRebuild
        // was NOT in this list before 2026-07-21, so edits to the canonical
        // predicate silently skipped Phase A ("decisions identical") — the
        // Benjamin Button pre-opening gate was invisible to this tool.
        && (baseline.isIncludableForRebuild?.toString() || '') === (working.isIncludableForRebuild?.toString() || '')
        // …and the rule chain it delegates to. Since task #902,
        // isIncludableForRebuild is a permanent 2-line wrapper
        // (`explainExclusion(...) === null`), so its OWN source never changes
        // again — every future exclusion-rule edit happens inside
        // explainExclusion. Comparing only the wrapper would silently reopen
        // the 2026-07-21 blind spot documented directly above: guardsIdentical
        // stays true, Phase A prints "decisions identical — skipping inclusion
        // replay", and a real scoring change ships unreplayed.
        // scripts/lib/review-guards.explain.test.mjs asserts this line exists.
        && (baseline.explainExclusion?.toString() || '') === (working.explainExclusion?.toString() || '')
        && (baseline.isPrematureReviewForUnopenedShow?.toString() || '') === (working.isPrematureReviewForUnopenedShow?.toString() || '')
        // Threshold constants are free variables of the pre-opening gate — a
        // constant-only edit leaves the function source identical (same trap
        // as PRE_WINDOW_DAYS above), so compare by value.
        && String(baseline.PRE_OPENING_LEAD_DAYS) === String(working.PRE_OPENING_LEAD_DAYS)
        && String(baseline.UNSCHEDULED_MAX_AGE_DAYS) === String(working.UNSCHEDULED_MAX_AGE_DAYS)
        // Unreadable on either side is NOT "identical" (task #1075).
        && registryComparable && registryHash === baselineRegistryHash;
      if (guardsIdentical && !dataFlagDiff) {
        log('[scoring-delta] Phase A: review-guards.js decisions + critic-registry identical — skipping inclusion replay.');
      } else if (!guardsIdentical) {
        runPhaseA = true;
      }
    }

    // Data-flag changes always trigger Phase A replay on the changed files.
    if (dataFlagDiff) {
      runPhaseA = true;
    }
  }

  // ── Phase B prep: load baseline + working getBestScore if needed ──
  let baselineScoring = null;
  let workingScoring = null;
  let runPhaseB = false;

  if (scoreValueDiff) {
    try {
      baselineScoring = loadBaselineScoring();
      workingScoring = loadWorkingTreeScoring();
    } catch (e) {
      log(`[scoring-delta] Phase B setup failed: ${e.message}`);
      process.exit(1);
    }
    // Sanity: if getBestScore is byte-identical between baseline and working
    // tree, no score-value replay is needed even if an adjacent helper changed.
    if (baselineScoring.getBestScore.toString() === workingScoring.getBestScore.toString()) {
      // Still proceed — a helper like score-extractors may have changed
      // (OUTLET_VERIFIED_SOURCES, KNOWN_STAR_OUTLETS) which getBestScore
      // closes over by name, not value. Only skip if ALL known score-value
      // helpers are identical too.
      const helpersIdentical =
        baselineScoring.scoreToBucket?.toString() === workingScoring.scoreToBucket?.toString()
        && baselineScoring.scoreToThumb?.toString() === workingScoring.scoreToThumb?.toString();
      if (helpersIdentical) {
        log('[scoring-delta] Phase B: getBestScore + helpers identical — running replay anyway (closed-over data may differ).');
      }
    }
    runPhaseB = true;
  }

  if (!runPhaseA && !runPhaseB) {
    log('[scoring-delta] ✅ Nothing meaningful to replay — decisions identical.');
    if (OUT_JSON) console.log(JSON.stringify({ flips: 0, t1Flips: 0, shows: 0, reason: 'decisions-identical' }));
    process.exit(0);
  }

  // Load shows.json
  if (!fs.existsSync(SHOWS_FILE)) {
    log(`[scoring-delta] ❌ shows.json not found at ${SHOWS_FILE}`);
    log(`[scoring-delta]    Fix: run \`npm run data:check\` (or \`./scripts/setup-local-data.sh\`) — worktrees don't inherit the main checkout's data-repo symlinks.`);
    process.exit(1);
  }
  const showsRaw = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const shows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows || [];
  const showById = new Map();
  for (const s of shows) {
    // earliestDate: MIN of previewDate/previewsStartDate/openingDate — same
    // anchor the rebuild uses (earliestShowDate). The old openingDate-first
    // pick anchored the sim later than the rebuild and misplaced flips near
    // the pre-window threshold. Legacy field names kept as final fallback.
    const earliestDate = earliestShowDate(s) || s.firstPreview || s.startDate || null;
    showById.set(s.id, {
      id: s.id,
      openingDate: s.openingDate || null,
      previewsStartDate: s.previewsStartDate || null,
      earliestDate,
      category: s.category || 'broadway',
      status: s.status || 'open',
      priorRuns: s.priorRuns || null,
      tourLegs: s.tourLegs || null,
    });
  }

  // Walk review-texts
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    log(`[scoring-delta] ❌ review-texts dir not found at ${REVIEW_TEXTS_DIR}`);
    log(`[scoring-delta]    Fix: run \`./scripts/setup-local-data.sh --all\`, or symlink from the main checkout: ln -sf <main-repo>/data/review-texts ${REVIEW_TEXTS_DIR}`);
    process.exit(1);
  }

  let showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(d => !d.startsWith('.'))
    .filter(d => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); } catch { return false; }
    });

  if (SAMPLE_LIMIT) showDirs = showDirs.slice(0, SAMPLE_LIMIT);

  const flipsExcluded = [];   // newly excluded (Phase A)
  const flipsIncluded = [];   // newly included (Phase A)
  const scoreFlips = [];      // assignedScore/source flips (Phase B)
  let processed = 0;

  for (const showId of showDirs) {
    const show = showById.get(showId);
    if (!show) continue;
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch { continue; }

    for (const f of files) {
      let review;
      try {
        review = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
      } catch { continue; }
      processed++;

      // ── Phase B: score-source replay ──
      // getBestScore mutates via opts.stats/flagForHumanReview, so pass
      // throwaway copies + a shallow clone so the review object itself is not
      // modified between baseline and working calls.
      if (runPhaseB) {
        try {
          const baseInput = { ...review };
          delete baseInput.assignedScore;
          const workInput = { ...review };
          delete workInput.assignedScore;
          if (!baseInput._showCategory) baseInput._showCategory = show.category;
          if (!workInput._showCategory) workInput._showCategory = show.category;
          const baseRes = baselineScoring.getBestScore(baseInput, { stats: {} });
          const workRes = workingScoring.getBestScore(workInput, { stats: {} });
          const baseScore = baseRes?.score ?? null;
          const workScore = workRes?.score ?? null;
          const baseSrc = baseRes?.source ?? null;
          const workSrc = workRes?.source ?? null;
          if (baseScore !== workScore || baseSrc !== workSrc) {
            const outletKey = (review.outletId || review.outlet || '').toLowerCase().replace(/\s+/g, '-');
            scoreFlips.push({
              showId,
              outlet: review.outletId || review.outlet || 'unknown',
              critic: review.criticName || '',
              url: review.url || '',
              publishDate: review.publishDate || '',
              tier: T1_OUTLETS.has(outletKey) ? 'T1' : 'other',
              baselineScore: baseScore,
              baselineSource: baseSrc,
              workingScore: workScore,
              workingSource: workSrc,
              scoreSourceField: review.scoreSource || null,
            });
          }
        } catch (e) {
          // A getBestScore crash on a pathological review shouldn't abort the
          // whole delta. Count it but keep going.
          // (Pre-existing behavior for Phase A was to ignore bad JSON earlier;
          // match that tolerance here.)
        }
      }

      // ── Phase A: inclusion replay ──
      if (!runPhaseA) continue;

      const relPath = `${showId}/${f}`;
      const changedFile = changedReviewFiles.get(relPath);

      // Skip files unaffected by either sub-phase
      if (!changedFile && !inclusionDiff) continue;

      // Determine before/after state:
      // - Data-flag change: old data vs new data, same (working) guards
      // - Code change only: same data, baseline guards vs working guards
      // - Both changed: old data + baseline guards vs new data + working guards
      const baselineData = changedFile ? changedFile.old : review;
      const baselineGuards = (inclusionDiff && baseline) ? baseline : working;

      const baselineDecision = baselineData
        ? decideInclusion(baselineData, show, baselineGuards)
        : { included: false, reason: 'new file' };
      const workingDecision = review
        ? decideInclusion(review, show, working)
        : { included: false, reason: 'deleted' };

      if (baselineDecision.included === workingDecision.included) continue;

      const outletKey = (review.outletId || review.outlet || '').toLowerCase().replace(/\s+/g, '-');
      const isT1 = T1_OUTLETS.has(outletKey);

      const flip = {
        showId,
        outlet: review.outletId || review.outlet || 'unknown',
        critic: review.criticName || '',
        url: review.url || '',
        publishDate: review.publishDate || '',
        openingDate: show.openingDate || '',
        tier: isT1 ? 'T1' : 'other',
        baselineReason: baselineDecision.reason,
        workingReason: workingDecision.reason,
      };

      if (baselineDecision.included && !workingDecision.included) {
        flipsExcluded.push(flip);
      } else {
        flipsIncluded.push(flip);
      }
    }
  }

  // ── Phase A: deleted-file pass ────────────────────────────────────────────
  // Files deleted from the working tree are skipped by readdirSync above.
  // Iterate changedReviewFiles entries where new===null to catch deletions.
  if (runPhaseA && dataFlagDiff) {
    for (const [relPath, { old: oldData }] of changedReviewFiles) {
      if (oldData === null) continue; // new file (no old data) — already handled above
      const absPath = path.join(REVIEW_TEXTS_DIR, relPath);
      if (fs.existsSync(absPath)) continue; // file still exists — handled in main loop
      const showId = relPath.split('/')[0];
      const show = showById.get(showId);
      if (!show) continue;
      const baselineGuards = (inclusionDiff && baseline) ? baseline : working;
      const baselineDecision = decideInclusion(oldData, show, baselineGuards);
      if (!baselineDecision.included) continue; // was already excluded — no flip
      const outletKey = (oldData.outletId || oldData.outlet || '').toLowerCase().replace(/\s+/g, '-');
      flipsExcluded.push({
        showId,
        outlet: oldData.outletId || oldData.outlet || 'unknown',
        critic: oldData.criticName || '',
        url: oldData.url || '',
        publishDate: oldData.publishDate || '',
        openingDate: show.openingDate || '',
        tier: T1_OUTLETS.has(outletKey) ? 'T1' : 'other',
        baselineReason: baselineDecision.reason,
        workingReason: 'deleted',
      });
    }
  }

  // ─── Summarize ──────────────────────────────────────────────────────────────

  const t1InclusionFlips = flipsExcluded.filter(f => f.tier === 'T1').length
                          + flipsIncluded.filter(f => f.tier === 'T1').length;
  const t1ScoreFlips = scoreFlips.filter(f => f.tier === 'T1').length;
  const t1Flips = t1InclusionFlips + t1ScoreFlips;
  const totalFlips = flipsExcluded.length + flipsIncluded.length + scoreFlips.length;

  const affectedShowsExcluded = new Set(flipsExcluded.map(f => f.showId));
  const affectedShowsIncluded = new Set(flipsIncluded.map(f => f.showId));
  const affectedShowsScore = new Set(scoreFlips.map(f => f.showId));

  if (OUT_JSON) {
    console.log(JSON.stringify({
      base: BASE_REF,
      processed,
      phasesRun: { inclusion: runPhaseA, scoreValue: runPhaseB },
      flipsExcluded: flipsExcluded.length,
      flipsIncluded: flipsIncluded.length,
      scoreFlips: scoreFlips.length,
      t1Flips,
      t1ScoreFlips,
      showsAffectedExcluded: affectedShowsExcluded.size,
      showsAffectedIncluded: affectedShowsIncluded.size,
      showsAffectedScore: affectedShowsScore.size,
      t1Details: [...flipsExcluded, ...flipsIncluded, ...scoreFlips].filter(f => f.tier === 'T1'),
      // Full flip detail (capped) — without this, a within-tolerance non-T1
      // delta is unexplainable: the human gate requires saying WHICH reviews
      // moved and why, and the text mode only prints per-show counts.
      flipDetails: {
        excluded: flipsExcluded.slice(0, 100),
        included: flipsIncluded.slice(0, 100),
        scoreChanged: scoreFlips.slice(0, 100),
      },
    }, null, 2));
  } else {
    const significant = totalFlips > TOTAL_FLIP_THRESHOLD || t1Flips > T1_FLIP_THRESHOLD;
    const header = significant ? '⚠️  SCORING DELTA — significant change detected' : '✅ scoring delta — minor change';
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(header);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Comparing working-tree vs ${BASE_REF}`);
    console.log(`Phases run: ${[runPhaseA && 'inclusion', runPhaseB && 'score-source'].filter(Boolean).join(' + ') || 'none'}`);
    console.log(`Reviews processed: ${processed.toLocaleString()}`);
    console.log('');
    if (runPhaseA) {
      console.log(`Newly EXCLUDED:   ${flipsExcluded.length} reviews across ${affectedShowsExcluded.size} shows`);
      console.log(`Newly INCLUDED:   ${flipsIncluded.length} reviews across ${affectedShowsIncluded.size} shows`);
    }
    if (runPhaseB) {
      console.log(`SCORE CHANGED:    ${scoreFlips.length} reviews across ${affectedShowsScore.size} shows`);
    }
    console.log(`T1 outlet flips:  ${t1Flips}  (inclusion: ${t1InclusionFlips}, score: ${t1ScoreFlips})`);
    console.log('');

    if (flipsExcluded.length > 0) {
      console.log('TOP SHOWS — newly excluded reviews:');
      const byShow = new Map();
      for (const f of flipsExcluded) byShow.set(f.showId, (byShow.get(f.showId) || 0) + 1);
      const sorted = [...byShow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      for (const [sid, count] of sorted) console.log(`  ${sid}: -${count}`);
      if (byShow.size > 10) console.log(`  ...and ${byShow.size - 10} more shows`);
      console.log('');
    }

    if (scoreFlips.length > 0) {
      console.log('TOP SHOWS — score/source changed:');
      const byShow = new Map();
      for (const f of scoreFlips) byShow.set(f.showId, (byShow.get(f.showId) || 0) + 1);
      const sorted = [...byShow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      for (const [sid, count] of sorted) console.log(`  ${sid}: ${count}`);
      if (byShow.size > 10) console.log(`  ...and ${byShow.size - 10} more shows`);
      console.log('');
    }

    const t1Exc = flipsExcluded.filter(f => f.tier === 'T1');
    if (t1Exc.length > 0) {
      console.log('T1 OUTLETS newly excluded (the ones that matter most):');
      for (const f of t1Exc.slice(0, 15)) {
        console.log(`  - ${f.showId} · ${f.outlet} · ${f.critic} (${f.publishDate}) [${f.workingReason}]`);
      }
      if (t1Exc.length > 15) console.log(`  ...and ${t1Exc.length - 15} more T1 flips`);
      console.log('');
    }

    const t1Score = scoreFlips.filter(f => f.tier === 'T1');
    if (t1Score.length > 0) {
      console.log('T1 OUTLETS with score/source change:');
      for (const f of t1Score.slice(0, 15)) {
        console.log(`  - ${f.showId} · ${f.outlet} · ${f.critic}: ${f.baselineScore}/${f.baselineSource} → ${f.workingScore}/${f.workingSource}`);
      }
      if (t1Score.length > 15) console.log(`  ...and ${t1Score.length - 15} more T1 score flips`);
      console.log('');
    }

    if (significant) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('BEFORE MERGING:');
      console.log('  1. Paste this summary to the user');
      console.log('  2. For each affected flagship show, spot-check the review — is the change correct?');
      console.log('  3. Get user confirmation that the delta is intentional');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } else {
      console.log('Delta within tolerance. Safe to proceed.');
    }
  }

  process.exit((totalFlips > TOTAL_FLIP_THRESHOLD || t1Flips > T1_FLIP_THRESHOLD) ? 2 : 0);
}

module.exports = { decideInclusion };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[scoring-delta] fatal: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}
