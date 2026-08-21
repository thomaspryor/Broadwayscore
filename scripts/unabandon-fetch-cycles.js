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
 * Two modes, deliberately different in how much they trust the caller:
 *
 * 1. BULK SCAN (no --show): re-derives each candidate's gate by calling
 *    shouldRetryFetch() again on a copy with fetchDiscoveryAbandoned
 *    cleared. If the lifecycle-tiered gate would now allow a retry (show
 *    reclassified, e.g. closingDate corrected, or the ledger's
 *    failureCount/failureReason changed), the abandonment is stale — clear
 *    it. Reuses the SAME single source of truth as the live gate rather
 *    than a second, independently-tuned check that could drift from it.
 *    Scoped to gate-derived provenance only (fetchAbandonmentReason unset,
 *    i.e. set by the live collect-review-texts.js path, or starting with
 *    'backfill:', i.e. set by backfill-fetch-abandonment.js) — a review
 *    abandoned with any OTHER reason string was a deliberate human call
 *    (shouldRetryFetch's own docstring: "only a human unsets it") and bulk
 *    mode must never silently override that.
 *
 * 2. TARGETED (--show=ID): unconditionally clears fetchDiscoveryAbandoned
 *    for every abandoned review under that show, no re-derivation or
 *    provenance check. Naming a specific show IS the human judgment call —
 *    this is the only path that can recover the "domain came back online"
 *    case, where the lifecycle-tiered gate legitimately still says no (the
 *    show's classification didn't change, only the operator's real-world
 *    knowledge did) but an operator has verified retrying is now safe.
 *
 * A ledger entry may no longer exist (cleaned up). Bulk mode has nothing to
 * re-derive against in that case and skips the file; targeted mode doesn't
 * need the ledger at all.
 *
 * Usage:
 *   node scripts/unabandon-fetch-cycles.js [--dry-run] [--show=ID]
 *
 * --dry-run   Print counts and sample mutations without writing
 * --show=ID   Unconditionally clear every abandoned review under this show
 *             (bypasses re-derivation and provenance scoping — see above)
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
  const raw = fs.readFileSync(failedPath, 'utf8');
  let failedFetches;
  try {
    failedFetches = JSON.parse(raw);
  } catch (parseErr) {
    // Missing file (ENOENT, caught below) is a normal empty-ledger state.
    // A PRESENT-but-corrupt ledger is not — bulk mode would silently treat
    // every candidate as "no ledger entry" and skip it, which looks
    // identical to "nothing to do" in the report. Warn loudly so an
    // operator doesn't mistake ledger corruption for a clean scan.
    console.error(`WARNING: ${failedPath} exists but failed to parse (${parseErr.message}) — proceeding as if no ledger entries exist. Bulk-mode candidates will be skipped; --show mode is unaffected.`);
    failedFetches = [];
  }
  for (const f of failedFetches) {
    const id = f.reviewId || (f.showId && f.file ? `${f.showId}/${f.file}` : null);
    if (!id) continue;
    failedFetchesByReviewId.set(id, { failureReason: f.failureReason || '', failureCount: f.failureCount || 1 });
  }
} catch (e) {
  // No ledger file at all — proceed with an empty map.
}

// Gate-derived abandonment provenance (bulk mode only — see header comment).
// The live collect-review-texts.js path never stamps a reason at all; only
// backfill-fetch-abandonment.js stamps 'backfill:<reason>:<count>'.
function isGateDerivedAbandonment(review) {
  const reason = review.fetchAbandonmentReason;
  return reason == null || reason.startsWith('backfill:');
}

// ---------------------------------------------------------------------------
// Scan and classify
// ---------------------------------------------------------------------------
let scanned = 0;
let abandoned = 0;
let notGateDerived = 0;
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

    // Targeted mode: unconditional clear, no re-derivation or provenance
    // check — naming --show=ID IS the human decision.
    if (SHOW_FILTER) {
      toClear.push({ filePath, reviewId, showId, failureReason: review.fetchAbandonmentReason || '(none)', failureCount: null, gateReason: 'targeted_override' });
      reasonBreakdown[review.fetchAbandonmentReason || '(none)'] = (reasonBreakdown[review.fetchAbandonmentReason || '(none)'] || 0) + 1;
      continue;
    }

    // Bulk mode: never override a human's own abandonment call.
    if (!isGateDerivedAbandonment(review)) {
      notGateDerived++;
      continue;
    }

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
if (SHOW_FILTER) {
  console.log(`Targeted mode (--show=${SHOW_FILTER}): unconditional clear, no re-derivation`);
} else {
  console.log('Not gate-derived (human-set reason, left alone):', notGateDerived);
  console.log('No ledger entry (skipped — nothing to re-derive against):', noLedgerEntry);
  console.log('Still correctly gated (left alone):', stillGated);
}
console.log('To clear:', toClear.length);
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
