#!/usr/bin/env node
/**
 * One-off fix for task #1837 (P0, 2026-08-19): carrie-1988/nytimes--unknown.json
 * carried a wrongProduction flag whose stated basis ("Date guard: review March 1,
 * 2012 is 8684d after 1988-05-15") cites a date that appears nowhere on the
 * record. The record's own url/publishDate (1988-05-13, matching the NYT URL
 * path /1988/05/13/) is the original 1988 Broadway Carrie notice — a genuinely
 * stale flag caught by audit-contradicted-flag-basis.js.
 *
 * Uses the canonical clearWrongProductionFlags() helper (scripts/lib/wrong-
 * production-clear.js) so every dependent field (embedded contentVerification,
 * contentTier reclassification, override breadcrumb) is corrected together —
 * a partial clear gets re-flagged on the next rebuild guard pass.
 *
 * The record is a stub (wordCount 0, isFullReview false, serpDiscoveryAbandoned
 * true — full text was never fetched, unrelated to production identity), so
 * clearing wrongProduction does not make it scoreable; Critic Score for
 * carrie-1988 does not move. This fixes a bad exclusion reason, not a missing
 * review.
 *
 * Usage: node scripts/fix-carrie-1988-nytimes-stale-flag-2026-08-19.js [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');
const { classifyContentTier } = require('./lib/content-quality');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-carrie-1988-nytimes-stale-flag-2026-08-19.js

Usage:
  node scripts/fix-carrie-1988-nytimes-stale-flag-2026-08-19.js [--dry-run]
`;
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const DRY_RUN = process.argv.includes('--dry-run');
// resolveReviewTextsDir(), not a hardcoded ~/broadway-review-texts default —
// that legacy clone can be silently stale (scripts/lib/review-texts-dir.js
// docblock, 2026-08-17 incident); a future copy of this one-off pattern must
// not default to it.
const REVIEW_TEXTS_DIR = resolveReviewTextsDir();
const FILE_PATH = path.join(REVIEW_TEXTS_DIR, 'carrie-1988', 'nytimes--unknown.json');

const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));

clearWrongProductionFlags(data, {
  source: 'fix-carrie-1988-nytimes-stale-flag-2026-08-19',
  reason: 'wrongProductionNote cited 2012-03-01, a date absent from the record; url/publishDate (1988-05-13, matching the NYT URL path /1988/05/13/) is the original 1988 production — task #1837',
});

// The helper only strips a stale incompleteReason when it was set to unblock
// contentTier via classifyContentTier; this record's incompleteDetail was the
// same "Wrong production" story and must go with it, or the audit trail still
// reads as wrong-production even though the flag is cleared.
delete data.incompleteDetail;

// classifyContentTier() also returns a fresh tierReason, but the helper only
// takes .contentTier — contentTierReason is left stamped "Wrong production"
// unless set here too, which would be exactly the stale-basis problem this
// fix exists to close.
const tierResult = classifyContentTier(data);
if (tierResult && tierResult.tierReason) {
  data.contentTierReason = tierResult.tierReason;
}

console.log(JSON.stringify(data, null, 2));

if (!DRY_RUN) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nWrote ${FILE_PATH}`);
} else {
  console.log('\n[dry-run] not written');
}
