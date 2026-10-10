#!/usr/bin/env node
/**
 * Backfill fetch-retry abandonment flags on stuck failed-fetches.json entries.
 *
 * Applies the new lifecycle-aware fetch retry policy (BRO-787,
 * scripts/lib/review-guards.js shouldRetryFetch/recordFetchAttempt)
 * retroactively: any failed-fetches.json entry whose failureCount already
 * meets or exceeds the lifecycle-tiered max for its show — most notably
 * closed-old shows (>180d closed) with a confirmed-dead URL (0 retries) —
 * gets fetchDiscoveryAbandoned: true stamped onto the review file NOW,
 * instead of waiting for the next failed fetch attempt (which itself costs
 * Browserbase/Bright Data/ScrapingBee spend the guard exists to stop).
 *
 * Reuses shouldRetryFetch directly rather than re-deriving the tiered
 * thresholds — single source of truth with the live gate wired into
 * collect-review-texts.js, so this script can never drift from it.
 *
 * Usage:
 *   node scripts/backfill-fetch-abandonment.js [--dry-run] [--limit N]
 *
 * --dry-run   Print counts and sample mutations without writing
 * --limit N   Process only the first N candidates (for spot-checking)
 *
 * See: BRO-787
 */

const fs = require('fs');
const path = require('path');
const { shouldRetryFetch } = require('./lib/review-guards');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : Infinity;

const REVIEW_TEXTS_DIR = 'data/review-texts';

// ---------------------------------------------------------------------------
// Load shows.json once so shouldRetryFetch can classify each show's lifecycle
// ---------------------------------------------------------------------------
let showsById = {};
try {
  const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
  const allShows = showsData.shows || showsData;
  for (const s of allShows) showsById[s.id] = s;
} catch (e) {
  console.error(`ERROR: Could not load data/shows.json: ${e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load the ledger
// ---------------------------------------------------------------------------
const failedPath = path.join(REVIEW_TEXTS_DIR, 'failed-fetches.json');
let failedFetches = [];
try {
  failedFetches = JSON.parse(fs.readFileSync(failedPath, 'utf8'));
} catch (e) {
  console.error(`ERROR: Could not load ${failedPath}: ${e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scan and classify
// ---------------------------------------------------------------------------
const candidates = [];
let scanned = 0;
let alreadyAbandoned = 0;
let missingReviewFile = 0;
let stillHasRetries = 0;
let notGated = 0; // no_evidence reasons (budget_capped) — never abandoned

for (const f of failedFetches) {
  scanned++;
  const reviewId = f.reviewId || (f.showId && f.file ? `${f.showId}/${f.file}` : null);
  if (!reviewId) continue;

  const filePath = path.join(REVIEW_TEXTS_DIR, reviewId);
  if (!fs.existsSync(filePath)) {
    missingReviewFile++;
    continue;
  }

  let review;
  try {
    review = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    continue;
  }

  if (review.fetchDiscoveryAbandoned === true) {
    alreadyAbandoned++;
    continue;
  }

  const show = showsById[f.showId] || null;
  const entry = { failureReason: f.failureReason || '', failureCount: f.failureCount || 1 };
  const gate = shouldRetryFetch(show, review, entry);

  if (!gate.shouldRetry && gate.updates && gate.updates.fetchDiscoveryAbandoned === true) {
    candidates.push({
      filePath,
      reviewId,
      showId: f.showId,
      failureReason: entry.failureReason,
      failureCount: entry.failureCount,
    });
  } else if (gate.reason === 'not_gated') {
    notGated++;
  } else {
    stillHasRetries++;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log('\n=== Fetch Retry Abandonment Backfill (BRO-787) ===\n');
console.log(`Ledger entries scanned:   ${scanned}`);
console.log(`Missing review file:      ${missingReviewFile}`);
console.log(`Already abandoned:        ${alreadyAbandoned}`);
console.log(`Not gated (budget_capped):${notGated}`);
console.log(`Still has retries left:   ${stillHasRetries}`);
console.log(`Candidates to abandon:    ${candidates.length}`);
console.log('');

const limited = candidates.slice(0, LIMIT);
if (LIMIT < Infinity && limited.length < candidates.length) {
  console.log(`--limit ${LIMIT} applied: processing ${limited.length} of ${candidates.length}`);
  console.log('');
}

if (DRY_RUN) {
  console.log('DRY RUN — sample of first 5 candidates:');
  for (const c of limited.slice(0, 5)) {
    console.log(`  ${c.reviewId} [${c.failureReason}, failureCount=${c.failureCount}]`);
  }
  console.log('');
  console.log(`Would write: ${limited.length} files with fetchDiscoveryAbandoned=true`);
  console.log('Re-run without --dry-run to apply.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Live write
// ---------------------------------------------------------------------------
console.log(`Writing to ${limited.length} files...`);
let written = 0;
let errors = 0;
const errorSamples = [];

for (const c of limited) {
  try {
    const review = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
    review.fetchDiscoveryAbandoned = true;
    review.fetchAbandonmentReason = `backfill:${c.failureReason}:${c.failureCount}`;
    review.fetchAbandonmentDate = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(c.filePath, JSON.stringify(review, null, 2) + '\n');
    written++;
    if (written % 1000 === 0) {
      console.log(`  ... ${written}/${limited.length}`);
    }
  } catch (e) {
    errors++;
    if (errorSamples.length < 5) {
      errorSamples.push(`${c.filePath}: ${e.message}`);
    }
  }
}

console.log('');
console.log(`Written: ${written}`);
console.log(`Errors: ${errors}`);
if (errorSamples.length > 0) {
  console.log('Error samples:');
  for (const s of errorSamples) console.log(`  ${s}`);
}

process.exit(errors > 0 && written === 0 ? 1 : 0);
