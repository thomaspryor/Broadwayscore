#!/usr/bin/env node
/**
 * scoring-delta.js — mandatory local verification for scoring/exclusion logic changes.
 *
 * When a session edits review-guards.js, rebuild-all-reviews.js, or adjacent scoring
 * logic, unit tests alone are structurally insufficient. This script replays the
 * core inclusion decision (contentVerification → wrongProduction promotion chain
 * with temporal override) against every review-text file under BOTH HEAD's logic
 * and the working-tree logic, then reports which reviews would flip inclusion.
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
 *   0 — no meaningful delta (≤5 T1 flips AND ≤30 total flips)
 *   2 — significant delta (session must confirm with user before merging)
 *   1 — script error
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

// ─── Load two versions of review-guards ──────────────────────────────────────

function loadBaselineGuards() {
  // Dump HEAD's version of review-guards.js + date-utils.js to a temp dir so we
  // can require() them independently from the working-tree version.
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scoring-delta-'));
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

  // Clear require cache and load baseline
  const baselinePath = path.join(baselineLibDir, 'review-guards.js');
  delete require.cache[require.resolve(baselinePath)];
  return require(baselinePath);
}

function loadWorkingTreeGuards() {
  const wtPath = path.resolve(REPO_ROOT, 'scripts/lib/review-guards.js');
  delete require.cache[require.resolve(wtPath)];
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
  // 1. Already-flagged top-level exclusions — present in both versions identically
  if (review.wrongShow === true) return { included: false, reason: 'wrongShow' };
  if (review.wrongProduction === true) return { included: false, reason: 'wrongProduction' };
  if (review.duplicateOf) return { included: false, reason: 'duplicateOf' };
  if (review.isRoundupArticle) return { included: false, reason: 'isRoundupArticle' };
  if (review.incompleteReason === 'wrong_content') return { included: false, reason: 'incompleteReason:wrong_content' };
  if (review.contentTier === 'invalid') return { included: false, reason: 'contentTier:invalid' };
  if (review.assignedScore == null) return { included: false, reason: 'no score' };

  // 2. Content-verification promotion chain (this is where temporal override acts)
  const cv = review.contentVerification;
  if (cv && (cv.confidence === 'high' || cv.confidence === 'medium')) {
    // Staleness check — skip if fullText fetched after verification
    let stale = false;
    if (review.textFetchedAt && cv.verifiedAt) {
      if (new Date(review.textFetchedAt).getTime() > new Date(cv.verifiedAt).getTime()) {
        stale = true;
      }
    }
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
    const threshold = (isOB || isLondon) ? 90 : 14;
    if (guards.isLikelyWrongProduction(review.publishDate, show.earliestDate, threshold)) {
      return { included: false, reason: `date-guard (>${threshold}d before show)` };
    }
  }

  if (review.url && show?.id && guards.isLikelyTourReview(review.url, show.id)) {
    return { included: false, reason: 'tour-review URL' };
  }

  if (review.url && guards.isRoundupUrl(review.url).isRoundup) {
    return { included: false, reason: 'roundup URL' };
  }

  return { included: true, reason: 'passes guards' };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  log(`[scoring-delta] Comparing working-tree vs ${BASE_REF}`);

  // Guard 1: is there even a diff to scoring logic?
  let diffStat = '';
  try {
    diffStat = execSync(
      `git diff ${BASE_REF} -- scripts/lib/review-guards.js scripts/rebuild-all-reviews.js src/lib/scoring.ts src/lib/engine.ts src/lib/data-core.ts`,
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
  } catch (e) {
    log(`[scoring-delta] git diff failed: ${e.message}`);
    process.exit(1);
  }

  if (!diffStat.trim()) {
    log('[scoring-delta] ✅ No changes to scoring/guard files vs ' + BASE_REF + ' — nothing to check.');
    if (OUT_JSON) console.log(JSON.stringify({ flips: 0, t1Flips: 0, shows: 0, reason: 'no-diff' }));
    process.exit(0);
  }

  const baseline = loadBaselineGuards();
  const working = loadWorkingTreeGuards();

  // Sanity: if both guards are string-identical, no delta to compute
  if (baseline.applyTemporalOverrides.toString() === working.applyTemporalOverrides.toString()
      && baseline.isLikelyWrongProduction.toString() === working.isLikelyWrongProduction.toString()
      && baseline.isLikelyTourReview.toString() === working.isLikelyTourReview.toString()
      && baseline.shouldSkipWrongProductionAudit.toString() === working.shouldSkipWrongProductionAudit.toString()) {
    log('[scoring-delta] ✅ review-guards.js decisions identical to ' + BASE_REF + ' — no delta.');
    if (OUT_JSON) console.log(JSON.stringify({ flips: 0, t1Flips: 0, shows: 0, reason: 'guards-identical' }));
    process.exit(0);
  }

  // Load shows.json
  if (!fs.existsSync(SHOWS_FILE)) {
    log(`[scoring-delta] ❌ shows.json not found at ${SHOWS_FILE}`);
    process.exit(1);
  }
  const showsRaw = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const shows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows || [];
  const showById = new Map();
  for (const s of shows) {
    // earliestDate = openingDate or first preview
    const earliestDate = s.openingDate || s.firstPreview || s.startDate || null;
    showById.set(s.id, {
      id: s.id,
      openingDate: s.openingDate || null,
      earliestDate,
      category: s.category || 'broadway',
      status: s.status || 'open',
    });
  }

  // Walk review-texts
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    log(`[scoring-delta] ❌ review-texts dir not found at ${REVIEW_TEXTS_DIR}`);
    process.exit(1);
  }

  let showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(d => !d.startsWith('.'))
    .filter(d => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); } catch { return false; }
    });

  if (SAMPLE_LIMIT) showDirs = showDirs.slice(0, SAMPLE_LIMIT);

  const flipsExcluded = [];   // newly excluded
  const flipsIncluded = [];   // newly included
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

      const baselineDecision = decideInclusion(review, show, baseline);
      const workingDecision = decideInclusion(review, show, working);

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

  // ─── Summarize ──────────────────────────────────────────────────────────────

  const t1Flips = flipsExcluded.filter(f => f.tier === 'T1').length
                + flipsIncluded.filter(f => f.tier === 'T1').length;
  const totalFlips = flipsExcluded.length + flipsIncluded.length;

  const affectedShowsExcluded = new Set(flipsExcluded.map(f => f.showId));
  const affectedShowsIncluded = new Set(flipsIncluded.map(f => f.showId));

  if (OUT_JSON) {
    console.log(JSON.stringify({
      base: BASE_REF,
      processed,
      flipsExcluded: flipsExcluded.length,
      flipsIncluded: flipsIncluded.length,
      t1Flips,
      showsAffectedExcluded: affectedShowsExcluded.size,
      showsAffectedIncluded: affectedShowsIncluded.size,
      t1Details: [...flipsExcluded, ...flipsIncluded].filter(f => f.tier === 'T1'),
    }, null, 2));
  } else {
    const significant = totalFlips > TOTAL_FLIP_THRESHOLD || t1Flips > T1_FLIP_THRESHOLD;
    const header = significant ? '⚠️  SCORING DELTA — significant change detected' : '✅ scoring delta — minor change';
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(header);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Comparing working-tree vs ${BASE_REF}`);
    console.log(`Reviews processed: ${processed.toLocaleString()}`);
    console.log('');
    console.log(`Newly EXCLUDED: ${flipsExcluded.length} reviews across ${affectedShowsExcluded.size} shows`);
    console.log(`Newly INCLUDED: ${flipsIncluded.length} reviews across ${affectedShowsIncluded.size} shows`);
    console.log(`T1 outlet flips: ${t1Flips}`);
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

    const t1Exc = flipsExcluded.filter(f => f.tier === 'T1');
    if (t1Exc.length > 0) {
      console.log('T1 OUTLETS newly excluded (the ones that matter most):');
      for (const f of t1Exc.slice(0, 15)) {
        console.log(`  - ${f.showId} · ${f.outlet} · ${f.critic} (${f.publishDate}) [${f.workingReason}]`);
      }
      if (t1Exc.length > 15) console.log(`  ...and ${t1Exc.length - 15} more T1 flips`);
      console.log('');
    }

    if (significant) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('BEFORE MERGING:');
      console.log('  1. Paste this summary to the user');
      console.log('  2. For each affected flagship show, spot-check the review — is exclusion correct?');
      console.log('  3. Get user confirmation that the delta is intentional');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } else {
      console.log('Delta within tolerance. Safe to proceed.');
    }
  }

  process.exit((totalFlips > TOTAL_FLIP_THRESHOLD || t1Flips > T1_FLIP_THRESHOLD) ? 2 : 0);
}

try {
  main();
} catch (e) {
  console.error(`[scoring-delta] fatal: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
