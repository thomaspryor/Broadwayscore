#!/usr/bin/env node
/**
 * Remediation for a bug in backfill-serp-abandonment.js (2026-04-11).
 *
 * The original backfill treated ANY file with `urlDiscoveredAt` set as a
 * proven SERP cycle and marked it serpDiscoveryAbandoned=true. But
 * urlDiscoveryMethod values like 'protocol-upgrade' (HTTP→HTTPS upgrade)
 * and 'http-redirect' (URL redirect follow) are routine URL normalizations,
 * NOT SERP cycles — they don't cost SERP credits to reproduce.
 *
 * This script clears serpDiscoveryAbandoned on files that were wrongly
 * abandoned because their urlDiscoveryMethod is not in the real-SERP set.
 * It also removes the stamped serpAbandonmentReason/Date and the
 * backfill-inserted serpRetryCount=1 (so the live gate treats them as
 * fresh candidates next run).
 *
 * Leaves alone files abandoned for OTHER reasons (closedOld, live gate,
 * manual abandonment) — only touches files with both:
 *   - serpAbandonmentReason === 'backfill:cycled'
 *   - urlDiscoveryMethod NOT in SERP_DISCOVERY_METHODS
 *
 * Usage:
 *   node scripts/unabandon-non-serp-cycles.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

const SERP_DISCOVERY_METHODS = new Set([
  'google-serp',
  'google-serp-reason-recovery',
  'show-not-mentioned-recovery',
  'wrongUrl-serp-retry',
]);

const REVIEW_TEXTS_DIR = 'data/review-texts';

let scanned = 0;
let cycledAbandoned = 0;
let toRemediate = 0;
let remediated = 0;
let errors = 0;
const methodBreakdown = {};

for (const showId of fs.readdirSync(REVIEW_TEXTS_DIR)) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  let stat;
  try { stat = fs.statSync(showDir); } catch { continue; }
  if (!stat.isDirectory()) continue;

  for (const f of fs.readdirSync(showDir)) {
    if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
    scanned++;
    const filePath = path.join(showDir, f);
    let review;
    try { review = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

    if (review.serpAbandonmentReason !== 'backfill:cycled') continue;
    cycledAbandoned++;

    const method = review.urlDiscoveryMethod || '(none)';
    if (SERP_DISCOVERY_METHODS.has(method)) continue; // legitimate cycle, keep abandoned

    toRemediate++;
    methodBreakdown[method] = (methodBreakdown[method] || 0) + 1;

    if (!DRY_RUN) {
      try {
        delete review.serpDiscoveryAbandoned;
        delete review.serpAbandonmentReason;
        delete review.serpAbandonmentDate;
        // Clear the backfill-inserted retry count so the live gate treats
        // this file as a fresh candidate (no prior attempts). Preserve it
        // if a real runtime attempt ever bumped it past 1.
        if (review.serpRetryCount === 1) {
          delete review.serpRetryCount;
        }
        fs.writeFileSync(filePath, JSON.stringify(review, null, 2) + '\n');
        remediated++;
      } catch (e) {
        errors++;
      }
    }
  }
}

console.log('Scanned:', scanned);
console.log('backfill:cycled abandoned:', cycledAbandoned);
console.log('To remediate (non-SERP method):', toRemediate);
console.log('');
console.log('Method breakdown:');
for (const [m, c] of Object.entries(methodBreakdown).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.toString().padStart(4)}  ${m}`);
}
console.log('');
if (DRY_RUN) {
  console.log('DRY RUN — re-run without --dry-run to apply.');
} else {
  console.log(`Remediated: ${remediated}`);
  console.log(`Errors: ${errors}`);
}
process.exit(errors > 0 && remediated === 0 ? 1 : 0);
