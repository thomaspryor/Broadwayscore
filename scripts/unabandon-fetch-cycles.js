#!/usr/bin/env node
/**
 * Rollback for the fetch retry lifecycle gate (BRO-787,
 * scripts/lib/review-guards.js shouldRetryFetch/recordFetchAttempt).
 *
 * shouldRetryFetch permanently gates a review once fetchDiscoveryAbandoned
 * is true — "only a human unsets it". There was no bulk-undo path if that
 * ever misfires: a show's closingDate/status data turns out wrong, or a
 * domain that 404'd comes back after a redesign. This is the sibling of
 * scripts/unabandon-non-serp-cycles.js, applied to the fetch guard instead
 * of the SERP guard.
 *
 * Re-derivation: for each abandoned review with a matching
 * failed-fetches.json ledger entry, call shouldRetryFetch() again on a copy
 * with fetchDiscoveryAbandoned cleared. If the lifecycle-tiered gate would
 * now allow a retry (show reclassified, e.g. closingDate corrected, or the
 * ledger's failureCount/failureReason changed), the abandonment is stale —
 * clear it. If the gate still says no (still closedOld + confirmed-dead,
 * still over the tiered max), leave it alone — re-deriving intentionally
 * reuses the SAME single source of truth as the live gate rather than a
 * second, independently-tuned check that could drift from it.
 *
 * A ledger entry may no longer exist (cleaned up, or the file was manually
 * abandoned without one) — those files fall back to the --show filter only,
 * since there's nothing to re-derive against.
 *
 * Usage:
 *   node scripts/unabandon-fetch-cycles.js [--dry-run] [--show=ID]
 *
 * --dry-run   Print counts and sample mutations without writing
 * --show=ID   Only consider review files under data/review-texts/ID/
 */

const fs = require('fs');
const path = require('path');
const { shouldRetryFetch } = require('./lib/review-guards');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `unabandon-fetch-cycles.js — rollback for fetchDiscoveryAbandoned (BRO-787's fetch retry lifecycle gate).

Usage:
  node scripts/unabandon-fetch-cycles.js [--dry-run] [--show=show-id]
  node scripts/unabandon-fetch-cycles.js --help, -h   print this usage and exit — no scans/writes
`;

const args = process.argv.slice(2);
if (hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }
const DRY_RUN = args.includes('--dry-run');
const showArg = args.find(a => a.startsWith('--show='));
const SHOW_FILTER = showArg ? showArg.slice('--show='.length) : null;

const REVIEW_TEXTS_DIR = 'data/review-texts';

// ---------------------------------------------------------------------------
// Load shows.json so shouldRetryFetch can classify each show's lifecycle
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
// Load the failed-fetches ledger (optional — a missing/unreadable ledger
// just means every abandoned file falls back to the no-ledger-entry path)
// ---------------------------------------------------------------------------
let failedFetchesByReviewId = new Map();
const failedPath = path.join(REVIEW_TEXTS_DIR, 'failed-fetches.json');
try {
  const failedFetches = JSON.parse(fs.readFileSync(failedPath, 'utf8'));
  for (const f of failedFetches) {
    const id = f.reviewId || (f.showId && f.file ? `${f.showId}/${f.file}` : null);
    if (!id) continue;
    failedFetchesByReviewId.set(id, { failureReason: f.failureReason || '', failureCount: f.failureCount || 1 });
  }
} catch (e) {
  // No ledger — proceed with an empty map.
}

// ---------------------------------------------------------------------------
// Scan and classify
// ---------------------------------------------------------------------------
let scanned = 0;
let abandoned = 0;
let noLedgerEntry = 0;
let stillGated = 0;
const toClear = [];
const reasonBreakdown = {};

const showDirs = SHOW_FILTER ? [SHOW_FILTER] : fs.readdirSync(REVIEW_TEXTS_DIR);

for (const showId of showDirs) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  let stat;
  try { stat = fs.statSync(showDir); } catch { continue; }
  if (!stat.isDirectory()) continue;

  for (const f of fs.readdirSync(showDir)) {
    if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
    scanned++;
    const reviewId = `${showId}/${f}`;
    const filePath = path.join(showDir, f);
    let review;
    try { review = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

    if (review.fetchDiscoveryAbandoned !== true) continue;
    abandoned++;

    const entry = failedFetchesByReviewId.get(reviewId);
    if (!entry) {
      noLedgerEntry++;
      continue;
    }

    const show = showsById[showId] || null;
    const probe = { ...review, fetchDiscoveryAbandoned: false };
    const gate = shouldRetryFetch(show, probe, entry);

    if (!gate.shouldRetry) {
      stillGated++;
      continue;
    }

    toClear.push({ filePath, reviewId, showId, failureReason: entry.failureReason, failureCount: entry.failureCount, gateReason: gate.reason });
    reasonBreakdown[entry.failureReason || '(none)'] = (reasonBreakdown[entry.failureReason || '(none)'] || 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log('Scanned:', scanned);
console.log('fetchDiscoveryAbandoned=true:', abandoned);
console.log('No ledger entry (skipped — nothing to re-derive against):', noLedgerEntry);
console.log('Still correctly gated (left alone):', stillGated);
console.log('To clear (lifecycle reclassified):', toClear.length);
console.log('');
console.log('failureReason breakdown of clears:');
for (const [r, c] of Object.entries(reasonBreakdown).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.toString().padStart(4)}  ${r}`);
}
console.log('');

if (DRY_RUN) {
  console.log('DRY RUN — sample of first 5 candidates:');
  for (const c of toClear.slice(0, 5)) {
    console.log(`  ${c.reviewId} [${c.failureReason}, failureCount=${c.failureCount}] -> ${c.gateReason}`);
  }
  console.log('');
  console.log('Re-run without --dry-run to apply.');
  process.exit(0);
}

let cleared = 0;
let errors = 0;
for (const c of toClear) {
  try {
    const review = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
    review.fetchDiscoveryAbandoned = null;
    review.fetchAbandonmentReason = null;
    review.fetchAbandonmentDate = null;
    safeWriteReview(c.filePath, review, { merge: false });
    cleared++;
  } catch (e) {
    errors++;
  }
}

console.log(`Cleared: ${cleared}`);
console.log(`Errors: ${errors}`);
process.exit(errors > 0 && cleared === 0 ? 1 : 0);
