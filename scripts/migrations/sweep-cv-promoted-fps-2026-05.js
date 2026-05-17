#!/usr/bin/env node
/**
 * One-shot migration: sweep-cv-promoted-fps-2026-05
 *
 * Sprint S3-T7. Walks every review-text file with:
 *   - wrongShow === true
 *   - wrongShowReason starting with "CV-promoted:"
 * and clears the wrongShow flag for those that NOW pass
 * `shouldDeferCvWrongShow()` (long-biographical outlet + >500 words +
 * opinion language). Applies S3-T5's new gate retroactively.
 *
 * Files that qualify are mutated as follows:
 *   wrongShow = false
 *   wrongShowCleared = true
 *   wrongShowManualClear = true
 *   flaggedForReview = true
 *   flagReason = 'cv-promotion-deferred'
 *   wrongShowReason is PRESERVED for audit trail
 *
 * Files where humanReviewedWrongProduction === true are NEVER cleared.
 *
 * Safety:
 *   - Hard 50-flip cap. If would-clear count > 50 (or --max-cap=N) -> ABORT pre-write.
 *   - Default mode is DRY-RUN. --apply requires --confirm-flips=N matching the
 *     live would-clear count.
 *
 * Usage:
 *   node scripts/migrations/sweep-cv-promoted-fps-2026-05.js
 *   node scripts/migrations/sweep-cv-promoted-fps-2026-05.js --apply --confirm-flips=N
 *   node scripts/migrations/sweep-cv-promoted-fps-2026-05.js --max-cap=1   (testing)
 *
 * Run from main repo root (/Users/tompryor/Broadwayscore) where data/review-texts/
 * is present.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.resolve(process.cwd(), 'data', 'review-texts');
const CV_PREFIX = 'CV-promoted:';
const DEFAULT_MAX_CAP = 25;
const TOP_N = 25;

// Pre-filter: CV reasoning text that indicates a non-review or different-show
// article. shouldDeferCvWrongShow rescues long-biographical-lead reviews of the
// CORRECT show; it does NOT rescue wrong-article-type content. When the CV's
// own reasoning matches these patterns, trust it regardless of outlet style.
const OBVIOUS_WRONG_ARTICLE_PATTERNS = /collection of short news|news items|roundup|listicle|different show|different play|not a review of|review of [^,]{1,80}, not |homepage|preview piece|preview article|interview with|news feature|news article|feature article|short item|article about|piece about|cultural\/historical essay|describing the show'?s background|without offering the critic'?s assessment/i;

// ---------- args ----------
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const confirmArg = args.find((a) => a.startsWith('--confirm-flips='));
const maxCapArg = args.find((a) => a.startsWith('--max-cap='));
const CONFIRM_FLIPS = confirmArg ? Number(confirmArg.split('=')[1]) : null;
const MAX_CAP = maxCapArg ? Number(maxCapArg.split('=')[1]) : DEFAULT_MAX_CAP;

if (APPLY && (CONFIRM_FLIPS === null || Number.isNaN(CONFIRM_FLIPS))) {
  console.error(
    'ERROR: --apply requires --confirm-flips=N where N matches the prior dry-run would-clear count.'
  );
  process.exit(1);
}

// ---------- locate shouldDeferCvWrongShow ----------
// Resolve from the worktree where this script lives (the lib lives in the same
// repo as this migration on the S3 branch). We allow override via env var
// SCRIPT_LIB_DIR for unusual layouts.
function resolveContentVerifier() {
  const tried = [];
  const candidates = [];
  if (process.env.SCRIPT_LIB_DIR) {
    candidates.push(path.join(process.env.SCRIPT_LIB_DIR, 'content-verifier.js'));
  }
  // Same scripts/lib next to this file's grandparent (scripts/migrations/.. -> scripts/lib)
  candidates.push(path.resolve(__dirname, '..', 'lib', 'content-verifier.js'));
  // Worktree fallback (this script may be run from main repo root)
  candidates.push(
    path.resolve(
      __dirname,
      '..',
      '..',
      '.claude',
      'worktrees',
      's3-cv-outlet-style',
      'scripts',
      'lib',
      'content-verifier.js'
    )
  );
  // Main repo lookup from cwd
  candidates.push(path.resolve(process.cwd(), 'scripts', 'lib', 'content-verifier.js'));
  for (const c of candidates) {
    tried.push(c);
    if (fs.existsSync(c)) return c;
  }
  console.error('ERROR: cannot locate scripts/lib/content-verifier.js. Tried:');
  for (const t of tried) console.error('  - ' + t);
  process.exit(1);
}

const verifierPath = resolveContentVerifier();
const { shouldDeferCvWrongShow } = require(verifierPath);
if (typeof shouldDeferCvWrongShow !== 'function') {
  console.error('ERROR: shouldDeferCvWrongShow is not exported from ' + verifierPath);
  process.exit(1);
}

// ---------- scan ----------
if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
  console.error('ERROR: review-texts dir not found at ' + REVIEW_TEXTS_DIR);
  console.error('Run from /Users/tompryor/Broadwayscore (main repo root).');
  process.exit(1);
}

function listReviewFiles(rootDir) {
  const files = [];
  const showDirs = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of showDirs) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue; // skip _pending etc.
    const showDir = path.join(rootDir, entry.name);
    let inner;
    try {
      inner = fs.readdirSync(showDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of inner) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith('.json')) continue;
      files.push(path.join(showDir, f.name));
    }
  }
  return files;
}

function safeReadJson(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const allFiles = listReviewFiles(REVIEW_TEXTS_DIR);

let scanned = 0; // files with wrongShow=true
let cvDerived = 0; // wrongShow=true AND CV-promoted: prefix
let humanProtected = 0; // skipped because humanReviewedWrongProduction === true
let skippedObviousWrongArticle = 0; // skipped because CV reasoning indicates wrong-article-type
const candidates = []; // qualifying files

for (const filePath of allFiles) {
  const data = safeReadJson(filePath);
  if (!data) continue;
  if (data.wrongShow !== true) continue;
  scanned += 1;

  const reason = typeof data.wrongShowReason === 'string' ? data.wrongShowReason : '';
  if (!reason.startsWith(CV_PREFIX)) continue;
  cvDerived += 1;

  if (data.humanReviewedWrongProduction === true) {
    humanProtected += 1;
    continue;
  }

  // Pre-filter: skip candidates whose CV reasoning text matches obvious
  // wrong-article-type patterns. shouldDeferCvWrongShow is designed to rescue
  // long-biographical-lead reviews of the CORRECT show — it is NOT a rescue
  // for scraper junk, headline dumps, different-show content, or non-review
  // articles. The CV's specific reasoning is trusted on these classes
  // regardless of outlet style.
  const cvText = reason.slice(CV_PREFIX.length).toLowerCase();
  if (OBVIOUS_WRONG_ARTICLE_PATTERNS.test(cvText)) {
    skippedObviousWrongArticle += 1;
    continue;
  }

  // Apply S3-T5 gate retroactively
  let defer = false;
  try {
    defer = shouldDeferCvWrongShow({
      outletId: data.outletId,
      fullText: data.fullText,
    });
  } catch {
    defer = false;
  }
  if (!defer) continue;

  candidates.push({
    filePath,
    showId: data.showId || path.basename(path.dirname(filePath)),
    outletId: data.outletId || 'unknown',
    criticName: data.criticName || 'unknown',
    wrongShowReason: reason,
  });
}

const wouldClear = candidates.length;

// ---------- pre-write gate ----------
console.log('=== sweep-cv-promoted-fps-2026-05 ===');
console.log('Mode:           ' + (APPLY ? 'APPLY' : 'DRY-RUN'));
console.log('Cap:            ' + MAX_CAP);
console.log('Total scanned:  ' + scanned + ' (wrongShow=true)');
console.log('CV-derived:     ' + cvDerived + ' (wrongShowReason starts with "' + CV_PREFIX + '")');
console.log('Human-protected (skipped): ' + humanProtected);
console.log('Skipped obvious wrong-article (CV reason match): ' + skippedObviousWrongArticle);
console.log('Would clear:    ' + wouldClear);
console.log('');

if (wouldClear > MAX_CAP) {
  console.error('ABORT: ' + wouldClear + ' would-clear > ' + MAX_CAP + ' cap');
  console.error('No files modified. Review candidates manually before raising the cap.');
  process.exit(1);
}

// ---------- top-N preview ----------
const topN = candidates.slice(0, TOP_N);
console.log('Top ' + topN.length + ' candidates (eyeball before --apply):');
console.log('------------------------------------------------------------');
topN.forEach((c, i) => {
  const idx = String(i + 1).padStart(2, ' ');
  console.log(
    idx +
      '. show=' +
      c.showId +
      '  outlet=' +
      c.outletId +
      '  critic=' +
      c.criticName
  );
  const trimmedReason = c.wrongShowReason.length > 120
    ? c.wrongShowReason.slice(0, 117) + '...'
    : c.wrongShowReason;
  console.log('    reason: ' + trimmedReason);
});
console.log('');

// ---------- dry-run end ----------
if (!APPLY) {
  console.log('DRY-RUN: would clear ' + wouldClear + '. Run with --apply --confirm-flips=' + wouldClear + ' to apply.');
  process.exit(0);
}

// ---------- apply ----------
if (CONFIRM_FLIPS !== wouldClear) {
  console.error(
    'ABORT: --confirm-flips=' +
      CONFIRM_FLIPS +
      ' does not match live would-clear count ' +
      wouldClear +
      '. Re-run dry-run, then pass the matching number.'
  );
  process.exit(1);
}

const nowIso = new Date().toISOString();
let written = 0;
const errors = [];

for (const c of candidates) {
  const data = safeReadJson(c.filePath);
  if (!data || data.wrongShow !== true) {
    errors.push({ file: c.filePath, err: 'state changed between scan and write' });
    continue;
  }
  data.wrongShow = false;
  data.wrongShowCleared = true;
  data.wrongShowManualClear = true;
  data.flaggedForReview = true;
  data.flagReason = 'cv-promotion-deferred';
  data.wrongShowClearedAt = nowIso;
  data.wrongShowClearedBy = 'sweep-cv-promoted-fps-2026-05';
  // KEEP wrongShowReason for audit-trail.
  try {
    fs.writeFileSync(c.filePath, JSON.stringify(data, null, 2) + '\n');
    written += 1;
  } catch (e) {
    errors.push({ file: c.filePath, err: e && e.message ? e.message : String(e) });
  }
}

console.log('APPLIED: wrote ' + written + ' of ' + wouldClear + ' files.');
if (errors.length) {
  console.error('WRITE ERRORS (' + errors.length + '):');
  for (const e of errors) console.error('  ' + e.file + ' :: ' + e.err);
  process.exit(2);
}
process.exit(0);
