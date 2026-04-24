#!/usr/bin/env node

/**
 * verify-review-recovery.js
 *
 * End-to-end verification that a review recovery actually made it through
 * the full pipeline: file → scored → rebuilt → deployed.
 *
 * Usage:
 *   node scripts/verify-review-recovery.js --show=mamma-mia-west-end-2021
 *   node scripts/verify-review-recovery.js --show=mamma-mia-west-end-2021 --production
 *   node scripts/verify-review-recovery.js --show=mamma-mia-west-end-2021 --file=attitude--attitude-magazine.json
 *
 * Flags:
 *   --show=SHOW_ID       Required. The show to check.
 *   --file=FILENAME      Optional. Check a specific review file only.
 *   --production         Also check the live production site (slower).
 *   --verbose            Show details for passing checks too.
 *
 * Checks (in pipeline order):
 *   1. JSON validity    — no conflict markers, valid parse
 *   2. Content quality  — fullText exists, contentTier != stub/invalid
 *   3. Exclusion flags  — wrongProduction, wrongShow, isRoundupArticle
 *   4. LLM scoring      — llmScore or assignedScore present
 *   5. Rebuild inclusion — review appears in reviews.json
 *   5.5 Local per-show JSON — public/data/shows/{showId}.json rv.length matches reviews.json
 *   6. Production (opt) — review count on live site matches local
 *
 * Exit codes:
 *   0 = all checks pass
 *   1 = at least one check failed
 *   2 = show not found or bad arguments
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { fetchLiveRc, countAggregate, countLocalPerShowJson } = require('./lib/review-count-probe');

// ── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
args.forEach(a => {
  const m = a.match(/^--([a-z-]+)(?:=(.+))?$/);
  if (m) flags[m[1]] = m[2] ?? true;
});

const showId = flags.show;
const specificFile = flags.file;
const checkProduction = !!flags.production;
const verbose = !!flags.verbose;

if (!showId) {
  console.error('Usage: node scripts/verify-review-recovery.js --show=SHOW_ID [--file=FILE] [--production] [--verbose]');
  process.exit(2);
}

// ── Paths ───────────────────────────────────────────────────────────────────

// Use cwd so the script works from the main repo even when the file lives in a worktree.
// data/review-texts is a git submodule/separate repo that only exists in the main checkout.
const ROOT = process.cwd();
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts', showId);
const REVIEWS_JSON = path.join(ROOT, 'data', 'reviews.json');
const BASE_URL = 'https://broadwayscorecard.com';

// ── Formatting ──────────────────────────────────────────────────────────────

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const SKIP = '\x1b[90m-\x1b[0m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let totalPass = 0;
let totalFail = 0;
let totalWarn = 0;

function pass(msg) { totalPass++; console.log(`  ${PASS} ${msg}`); }
function fail(msg) { totalFail++; console.log(`  ${FAIL} ${msg}`); }
function warn(msg) { totalWarn++; console.log(`  ${WARN} ${msg}`); }
function skip(msg) { console.log(`  ${SKIP} ${msg}`); }
function info(msg) { if (verbose) console.log(`    ${msg}`); }

// ── Check 0: Directory exists ───────────────────────────────────────────────

console.log(`\n${BOLD}Verifying review recovery: ${showId}${RESET}`);
console.log(`${'─'.repeat(60)}\n`);

if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
  console.error(`Directory not found: ${REVIEW_TEXTS_DIR}`);
  process.exit(2);
}

const allFiles = fs.readdirSync(REVIEW_TEXTS_DIR).filter(f => f.endsWith('.json'));
const filesToCheck = specificFile ? [specificFile] : allFiles;

if (filesToCheck.length === 0) {
  console.error('No review files found.');
  process.exit(2);
}

console.log(`${BOLD}Step 1: JSON validity${RESET} (${filesToCheck.length} files)`);

// ── Check 1: JSON validity + conflict markers ──────────────────────────────

const parsed = new Map();
let conflictCount = 0;
let parseErrorCount = 0;

for (const file of filesToCheck) {
  const filepath = path.join(REVIEW_TEXTS_DIR, file);
  const raw = fs.readFileSync(filepath, 'utf8');

  // Check for git conflict markers
  if (raw.includes('<<<<<<<') || raw.includes('>>>>>>>') || raw.includes('=======\n')) {
    fail(`${file} — has git conflict markers (broken JSON)`);
    conflictCount++;
    continue;
  }

  try {
    const data = JSON.parse(raw);
    parsed.set(file, data);
    info(`${file} — valid JSON`);
  } catch (e) {
    fail(`${file} — invalid JSON: ${e.message.slice(0, 80)}`);
    parseErrorCount++;
  }
}

if (conflictCount === 0 && parseErrorCount === 0) {
  pass(`All ${filesToCheck.length} files are valid JSON with no conflict markers`);
}

// ── Check 2: Content quality ────────────────────────────────────────────────

console.log(`\n${BOLD}Step 2: Content quality${RESET}`);

let noTextCount = 0;
let stubCount = 0;
const contentOk = [];

for (const [file, data] of parsed) {
  const tier = data.contentTier;
  const hasText = data.fullText && data.fullText.length > 50;
  const words = data.textWordCount || (data.fullText ? data.fullText.split(/\s+/).length : 0);

  if (!hasText) {
    if (data.textStatus === 'not_collected') {
      fail(`${file} — not collected yet (textStatus=not_collected)`);
    } else {
      warn(`${file} — no fullText (${words} words, tier: ${tier || 'null'})`);
    }
    noTextCount++;
  } else if (tier === 'stub' || tier === 'invalid') {
    warn(`${file} — contentTier=${tier} (${words} words) — may be excluded from rebuild`);
    stubCount++;
  } else {
    contentOk.push(file);
    info(`${file} — ${tier} (${words} words)`);
  }
}

if (contentOk.length > 0) {
  pass(`${contentOk.length} files have usable content (complete/truncated/excerpt)`);
}

// ── Check 3: Exclusion flags ────────────────────────────────────────────────

console.log(`\n${BOLD}Step 3: Exclusion flags${RESET}`);

let excludedCount = 0;
const includable = [];

for (const [file, data] of parsed) {
  const reasons = [];
  if (data.wrongProduction) reasons.push('wrongProduction');
  if (data.wrongShow) reasons.push('wrongShow');
  if (data.isRoundupArticle) reasons.push('isRoundupArticle');
  if (data.contentTier === 'invalid') reasons.push('contentTier=invalid');
  if (data.contentTier === 'stub') reasons.push('contentTier=stub');

  if (reasons.length > 0) {
    const detail = data.wrongProductionReason || data.wrongShowReason || '';
    warn(`${file} — EXCLUDED: ${reasons.join(', ')}${detail ? ' (' + detail.slice(0, 60) + ')' : ''}`);
    excludedCount++;
  } else {
    includable.push(file);
    info(`${file} — no exclusion flags`);
  }
}

if (includable.length > 0) {
  pass(`${includable.length} files pass exclusion checks (will be included in rebuild)`);
}
if (excludedCount > 0) {
  console.log(`  ${WARN} ${excludedCount} files excluded by flags (expected for wrong-production/wrong-show)`);
}

// ── Check 4: LLM scoring ───────────────────────────────────────────────────

console.log(`\n${BOLD}Step 4: LLM scoring${RESET}`);

let scoredCount = 0;
let unscoredIncludable = 0;

for (const [file, data] of parsed) {
  const hasScore = data.assignedScore != null || data.llmScore != null || data.ensembleData != null;
  const isIncludable = includable.includes(file);

  if (hasScore) {
    scoredCount++;
    const score = data.assignedScore ?? data.llmScore?.score ?? '?';
    const bucket = data.bucket || data.llmScore?.bucket || '?';
    info(`${file} — score: ${score}, bucket: ${bucket}`);
  } else if (isIncludable && contentOk.includes(file)) {
    fail(`${file} — has content but NO LLM score (scoring pipeline missed it)`);
    unscoredIncludable++;
  } else if (isIncludable) {
    skip(`${file} — no content to score yet`);
  }
}

if (scoredCount > 0) {
  pass(`${scoredCount} files have LLM scores`);
}
if (unscoredIncludable > 0) {
  console.log(`  ${FAIL} ${unscoredIncludable} includable files with content but no score — run: gh workflow run "LLM Ensemble Score Reviews" -f show=${showId}`);
}

// ── Check 5: Rebuild inclusion ──────────────────────────────────────────────

console.log(`\n${BOLD}Step 5: Rebuild inclusion (reviews.json)${RESET}`);

let reviewsData;
try {
  reviewsData = JSON.parse(fs.readFileSync(REVIEWS_JSON, 'utf8'));
} catch {
  warn('Could not read reviews.json — skipping rebuild check');
  reviewsData = null;
}

if (reviewsData) {
  const reviews = reviewsData.reviews || [];
  const showReviews = reviews.filter(r => r.showId === showId);
  const reviewKeys = new Set(showReviews.map(r => `${r.outletId}||${(r.criticName || '').toLowerCase()}`));

  console.log(`  Reviews in reviews.json for ${showId}: ${showReviews.length}`);

  // Check which includable+scored files made it into reviews.json
  let inReviews = 0;
  let missingFromReviews = 0;

  for (const file of includable) {
    const data = parsed.get(file);
    if (!data || data.assignedScore == null) continue; // can't be in reviews without a score
    const key = `${data.outletId}||${(data.criticName || '').toLowerCase()}`;
    if (reviewKeys.has(key)) {
      inReviews++;
      info(`${file} — found in reviews.json`);
    } else {
      fail(`${file} — scored but MISSING from reviews.json (rebuild needed)`);
      missingFromReviews++;
    }
  }

  if (inReviews > 0) pass(`${inReviews} scored reviews found in reviews.json`);
  if (missingFromReviews > 0) {
    console.log(`  ${FAIL} ${missingFromReviews} scored reviews missing — run: gh workflow run "Refresh Review Data"`);
  }
}

// ── Check 5.5: Local per-show JSON (stage 2→3) ─────────────────────────────

console.log(`\n${BOLD}Step 5.5: Local per-show JSON (public/data/shows)${RESET}`);

if (reviewsData) {
  const aggCount = countAggregate(showId, reviewsData);
  const perShow = countLocalPerShowJson(showId, path.join(ROOT, 'public', 'data', 'shows'));

  if (!perShow) {
    fail(`public/data/shows/${showId}.json — MISSING (generate-mobile-show-details.js did not run or filtered this show out)`);
  } else if (perShow.reviewsArrayLength !== aggCount) {
    fail(`public/data/shows/${showId}.json — stage 2→3 drift: reviews.json has ${aggCount}, per-show JSON rv has ${perShow.reviewsArrayLength}`);
    console.log(`  Fix: node scripts/generate-mobile-show-details.js`);
  } else if (perShow.rc !== null && perShow.rc !== perShow.reviewsArrayLength) {
    warn(`public/data/shows/${showId}.json — rc cache skew: rc=${perShow.rc}, rv.length=${perShow.reviewsArrayLength} (cached count out of date)`);
  } else {
    pass(`public/data/shows/${showId}.json — ${perShow.reviewsArrayLength} reviews match reviews.json`);
  }
} else {
  skip('Skipped (could not read reviews.json)');
}

// ── Check 6: Production (optional) ─────────────────────────────────────────

if (checkProduction) {
  console.log(`\n${BOLD}Step 6: Production check${RESET}`);

  // fetchLiveRc reads the `rc` field from /data/shows/{id}.json (verified 2026-04-16).
  // The old HTML grep for "reviewCount" was broken — that field doesn't exist in rendered HTML.
  fetchLiveRc(showId).then(({ rc, err }) => {
    if (err) {
      warn(`Production check failed: ${err}`);
      return;
    }

    const localCount = reviewsData ? countAggregate(showId, reviewsData) : null;

    if (localCount !== null && rc === localCount) {
      pass(`Production matches local: ${rc} reviews`);
    } else if (localCount !== null && rc < localCount) {
      warn(`Production has ${rc} reviews but local has ${localCount} — deploy pending`);
    } else {
      pass(`Production shows ${rc} reviews`);
    }
  }).catch(e => {
    warn(`Production check failed: ${e.message.slice(0, 80)}`);
  });
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`${BOLD}Summary:${RESET} ${totalPass} passed, ${totalFail} failed, ${totalWarn} warnings`);
console.log(`Files: ${allFiles.length} total, ${includable.length} includable, ${scoredCount} scored`);

if (totalFail > 0) {
  console.log(`\n${FAIL} ${BOLD}Recovery incomplete — ${totalFail} issue(s) to fix${RESET}`);

  // Actionable next steps
  if (conflictCount > 0) {
    console.log(`\n  Fix conflict markers:`);
    console.log(`    grep -rl "<<<<<<" data/review-texts/${showId}/`);
  }
  if (unscoredIncludable > 0) {
    console.log(`\n  Trigger scoring:`);
    console.log(`    gh workflow run "LLM Ensemble Score Reviews" -f show=${showId}`);
  }
  if (reviewsData) {
    const missing = includable.filter(f => {
      const d = parsed.get(f);
      if (!d || d.assignedScore == null) return false;
      const key = `${d.outletId}||${(d.criticName || '').toLowerCase()}`;
      return !(reviewsData.reviews || []).some(r =>
        r.showId === showId && `${r.outletId}||${(r.criticName || '').toLowerCase()}` === key
      );
    });
    if (missing.length > 0) {
      console.log(`\n  Trigger rebuild:`);
      console.log(`    gh workflow run "Refresh Review Data"`);
    }
  }
  console.log('');
  process.exit(1);
} else {
  console.log(`\n${PASS} ${BOLD}Recovery complete — all checks passed${RESET}\n`);
  process.exit(0);
}
