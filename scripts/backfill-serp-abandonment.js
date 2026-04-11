#!/usr/bin/env node
/**
 * Backfill SERP abandonment flags on stuck review files.
 *
 * Applies the new lifecycle-aware retry policy retroactively:
 *
 *   1. Any wrong_content file where the show is closedOld (>180d closed)
 *      → serpDiscoveryAbandoned: true (tier max = 0 retries; SERP date
 *      windows are frozen, re-querying deterministic queries is pure waste)
 *
 *   2. Any wrong_content file where urlDiscoveredAt is already set AND the
 *      discovery method was a REAL SERP call (not a protocol upgrade or HTTP
 *      redirect follow, which are routine URL normalizations unrelated to
 *      SERP cycle pathology). These files have proven that SERP already found
 *      a "replacement" URL once and the replacement ALSO ended up wrong_content.
 *      → serpDiscoveryAbandoned: true (except openWindow where opening-night
 *      signal pickup still matters)
 *
 *   Ship-check 2026-04-11 found that the original rule #2 incorrectly marked
 *   934 files with urlDiscoveryMethod in {protocol-upgrade, http-redirect,
 *   domain-redirect} — those are HTTP→HTTPS upgrades and redirect-follows, not
 *   SERP cycles. The SERP_DISCOVERY_METHODS whitelist below fixes that.
 *
 * This captures ~83% of the forecasted SERP savings in one atomic sweep.
 * Without it, the lifecycle gate still works — but savings trickle in over
 * weeks as each stuck file hits the gate once and is gated.
 *
 * Usage:
 *   node scripts/backfill-serp-abandonment.js [--dry-run] [--limit N]
 *
 * --dry-run   Print counts and sample mutations without writing
 * --limit N   Process only the first N candidates (for spot-checking)
 *
 * See: sprint-plan-serp-cost-reduction.md S4-T1/T2
 */

const fs = require('fs');
const path = require('path');
const { classifyLifecycle } = require('./lib/review-guards');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : Infinity;

// Only these urlDiscoveryMethod values indicate a real SERP cycle. Others
// like 'protocol-upgrade' / 'http-redirect' / 'domain-redirect' are URL
// normalizations that don't prove cycle pathology — they don't cost SERP
// credits to reproduce.
const SERP_DISCOVERY_METHODS = new Set([
  'google-serp',
  'google-serp-reason-recovery',
  'show-not-mentioned-recovery',
  'wrongUrl-serp-retry',
]);

// ---------------------------------------------------------------------------
// Load shows.json once so classifyLifecycle can look up each show
// ---------------------------------------------------------------------------
const REVIEW_TEXTS_DIR = 'data/review-texts';
let showsById;
try {
  const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
  showsById = {};
  for (const s of showsData.shows) showsById[s.id] = s;
} catch (e) {
  console.error(`ERROR: Could not load data/shows.json: ${e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scan and classify
// ---------------------------------------------------------------------------
const candidates = {
  closedOld: [],       // wrong_content on shows closed >180d (max=0 retries)
  cycledNonOpening: [], // wrong_content with urlDiscoveredAt set, not in opening window
  skippedOpeningCycled: [], // wrong_content with urlDiscoveredAt but still in openWindow (keep retries)
};

let scanned = 0;
let totalWrongContent = 0;
let alreadyAbandoned = 0;

for (const showId of fs.readdirSync(REVIEW_TEXTS_DIR)) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  let stat;
  try { stat = fs.statSync(showDir); } catch { continue; }
  if (!stat.isDirectory()) continue;

  const show = showsById[showId];
  const lifecycle = classifyLifecycle(show);

  for (const f of fs.readdirSync(showDir)) {
    if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
    scanned++;

    const filePath = path.join(showDir, f);
    let review;
    try {
      review = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch { continue; }

    if (review.incompleteReason !== 'wrong_content') continue;
    totalWrongContent++;

    if (review.serpDiscoveryAbandoned === true) {
      alreadyAbandoned++;
      continue;
    }

    // A "cycled" file has BOTH urlDiscoveredAt AND a method that represents a
    // real SERP call. Protocol upgrades and HTTP redirects don't count.
    const hasPriorSerpCycle = !!review.urlDiscoveredAt
      && SERP_DISCOVERY_METHODS.has(review.urlDiscoveryMethod);

    // Rule 1: closedOld → abandon
    if (lifecycle === 'closedOld') {
      candidates.closedOld.push({ filePath, showId, lifecycle, hasPriorSerpCycle });
      continue;
    }

    // Rule 2: has real SERP cycle AND not in openWindow → abandon (cycle proven)
    if (hasPriorSerpCycle && lifecycle !== 'openWindow') {
      candidates.cycledNonOpening.push({ filePath, showId, lifecycle, hasPriorSerpCycle });
      continue;
    }

    // Rule 2b (skipped): openWindow with SERP cycle — keep the retries
    if (hasPriorSerpCycle && lifecycle === 'openWindow') {
      candidates.skippedOpeningCycled.push({ filePath, showId, lifecycle });
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log('\n=== SERP Abandonment Backfill ===\n');
console.log(`Scanned: ${scanned} review files`);
console.log(`Total wrong_content: ${totalWrongContent}`);
console.log(`Already abandoned: ${alreadyAbandoned}`);
console.log('');
console.log(`Candidates to abandon:`);
console.log(`  closedOld:                       ${candidates.closedOld.length}`);
console.log(`  cycled (urlDiscoveredAt, !openWindow): ${candidates.cycledNonOpening.length}`);
console.log(`  TOTAL:                           ${candidates.closedOld.length + candidates.cycledNonOpening.length}`);
console.log('');
console.log(`Preserved (openWindow with urlDiscoveredAt): ${candidates.skippedOpeningCycled.length}`);
console.log('');

const toProcess = [...candidates.closedOld, ...candidates.cycledNonOpening];
const limited = toProcess.slice(0, LIMIT);

if (LIMIT < Infinity && limited.length < toProcess.length) {
  console.log(`--limit ${LIMIT} applied: processing ${limited.length} of ${toProcess.length}`);
  console.log('');
}

if (DRY_RUN) {
  console.log('DRY RUN — sample of first 5 candidates:');
  for (const c of limited.slice(0, 5)) {
    console.log(`  ${c.filePath.replace(REVIEW_TEXTS_DIR + '/', '')} [${c.lifecycle}${c.hasPriorDiscovery ? ', prior-discovery' : ''}]`);
  }
  console.log('');
  console.log(`Would write: ${limited.length} files with serpDiscoveryAbandoned=true`);
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
    review.serpDiscoveryAbandoned = true;
    // Record intent in a new field so we can audit later
    review.serpAbandonmentReason = c.hasPriorSerpCycle
      ? 'backfill:cycled'
      : 'backfill:closedOld';
    review.serpAbandonmentDate = new Date().toISOString().slice(0, 10);
    // Preserve serpRetryCount if it's set; otherwise record that this is a
    // backfilled abandonment (never actually attempted via the new guard)
    if (typeof review.serpRetryCount !== 'number') {
      review.serpRetryCount = c.hasPriorSerpCycle ? 1 : 0;
    }
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
