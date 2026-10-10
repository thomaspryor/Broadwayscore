#!/usr/bin/env node

/**
 * apply-llm-hallucination-fix.js
 *
 * Quarantines review-text files confirmed (by hand) to contain LLM-hallucinated
 * fullText. Source list:
 *
 *   1. data/audit/llm-hallucination-suspects.json (Cohort A live suspects), MINUS
 *      the explicit `SKIP_LEGIT` allow-list below for false positives.
 *   2. Manually-added entries from the short-title audit (Task 3) that didn't
 *      pass through Cohort A because of `needsReview:true` etc.
 *
 * Quarantine action (mirrors rebuild-all-reviews.js auto-clear behavior):
 *   - Move fullText → wrongFullText
 *   - Set showNotMentioned: true
 *   - Set needsReview: true
 *   - Set suspectedLlmHallucination: true
 *   - Set needsReviewReason: short note
 *   - Preserve assignedScore, url, contentVerification, everything else.
 *
 * Usage:
 *   node scripts/apply-llm-hallucination-fix.js            # dry run (default)
 *   node scripts/apply-llm-hallucination-fix.js --apply    # actually write
 *
 * The dry run always runs first and prints exactly which files would change.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const AUDIT_PATH = path.join(DATA_DIR, 'audit', 'llm-hallucination-suspects.json');

const APPLY = process.argv.includes('--apply');

// Confirmed legitimate reviews that surface in the audit as false positives.
// The keyword gate is tuned for recall over precision on short titles — these
// are the cases I hand-read and confirmed are real reviews of the target show.
const SKIP_LEGIT = new Set([
  // Full RoI review about "runaway scientific advancements and extractive
  // capitalism" — legit review, just uses no keyword from the keyword set.
  'roi-return-on-investment-west-end-2026/thestage--dave-fargnoli.json',
]);

// Manually-added quarantine targets from the Task 3 short-title audit. These
// didn't appear in Cohort A because of `needsReview:true` or similar filters.
const MANUAL_ADDITIONS = [
  {
    filePath: 'data/review-texts/grease-2007/amny--matt-windman.json',
    reason: 'fullText is a review of "Grace" by Craig Wright (Michael Shannon/Paul Rudd), not Grease',
  },
];

// ---------------------------------------------------------------------------

const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
const plannedChanges = [];

for (const suspect of audit.liveSuspects) {
  const rel = path.relative(REVIEW_TEXTS_DIR, path.resolve(suspect.filePath));
  if (SKIP_LEGIT.has(rel)) {
    console.log(`SKIP (legit false positive): ${rel}`);
    continue;
  }
  plannedChanges.push({
    filePath: path.resolve(suspect.filePath),
    rel,
    reason: `LLM verified isValid:true but no show keyword in fullText. Verified by ${suspect.verifiedBy}. Preview: ${suspect.fullTextPreview.slice(0, 120).replace(/\s+/g, ' ')}`,
    source: 'cohort-A',
  });
}

for (const m of MANUAL_ADDITIONS) {
  plannedChanges.push({
    filePath: path.resolve(m.filePath),
    rel: path.relative(REVIEW_TEXTS_DIR, path.resolve(m.filePath)),
    reason: m.reason,
    source: 'manual-addition',
  });
}

console.log('');
console.log(`Planned changes: ${plannedChanges.length}`);
console.log('================');

let applied = 0;
let skippedNotFound = 0;
let skippedAlreadyQuarantined = 0;

for (const change of plannedChanges) {
  if (!fs.existsSync(change.filePath)) {
    console.log(`  MISSING  ${change.rel}`);
    skippedNotFound++;
    continue;
  }
  const data = JSON.parse(fs.readFileSync(change.filePath, 'utf8'));
  if (!data.fullText) {
    console.log(`  SKIP     ${change.rel} (already quarantined: no fullText)`);
    skippedAlreadyQuarantined++;
    continue;
  }
  console.log(`  QUARANT  ${change.rel} (fullText ${data.fullText.length} chars, score=${data.assignedScore})`);
  if (APPLY) {
    data.wrongFullText = data.fullText;
    data.fullText = null;
    data.showNotMentioned = true;
    data.needsReview = true;
    data.suspectedLlmHallucination = true;
    data.needsReviewReason = `LLM-hallucinated fullText quarantined by apply-llm-hallucination-fix.js (${change.source}): ${change.reason.slice(0, 200)}`;
    // Downgrade contentTier so rebuild knows this file needs rescrape
    data.contentTier = 'needs-rescrape';
    fs.writeFileSync(change.filePath, JSON.stringify(data, null, 2) + '\n');
    applied++;
  }
}

console.log('');
console.log('Summary');
console.log('=======');
console.log(`  Planned:              ${plannedChanges.length}`);
console.log(`  Missing on disk:      ${skippedNotFound}`);
console.log(`  Already quarantined:  ${skippedAlreadyQuarantined}`);
console.log(`  Would-quarantine:     ${plannedChanges.length - skippedNotFound - skippedAlreadyQuarantined}`);
if (APPLY) {
  console.log(`  APPLIED:              ${applied}`);
} else {
  console.log('');
  console.log('  This was a DRY RUN. Re-run with --apply to write changes.');
}
