#!/usr/bin/env node
/**
 * Apply human review fixes
 * For reviews where LLM Pan/Negative scores conflict with Meh/Up thumbs,
 * downgrade LLM confidence to 'low' so thumb override applies in rebuild.
 * For "both thumbs Up" cases where LLM scored too low, same approach.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { areCriticsSimilar } = require('./lib/review-normalization');

/**
 * Resolve the one review-text file a fix targets (BRO-2619).
 * Same outletId (case-insensitive), narrowed by fix.criticName when present.
 * Only a single candidate is returned; two same-outlet files (e.g. two critics
 * at one outlet) are 'ambiguous' and never resolved by directory order.
 * @returns {{status:'found', filePath, data} | {status:'ambiguous', candidates} | {status:'not-found'}}
 */
function findFixTarget(showDir, fix) {
  const want = (fix.outletId || '').toLowerCase();
  if (!want) return { status: 'not-found' };
  let candidates = [];
  for (const f of fs.readdirSync(showDir).filter(n => n.endsWith('.json')).sort()) {
    const filePath = path.join(showDir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { continue; }
    if ((data.outletId || '').toLowerCase() === want) candidates.push({ filePath, data });
  }
  if (fix.criticName) {
    candidates = candidates.filter(c => !c.data.criticName || areCriticsSimilar(c.data.criticName, fix.criticName));
  }
  if (candidates.length === 1) return { status: 'found', ...candidates[0] };
  if (candidates.length > 1) return { status: 'ambiguous', candidates: candidates.map(c => path.basename(c.filePath)) };
  return { status: 'not-found' };
}

module.exports = { findFixTarget };

function main() {
  const USAGE = `apply-human-review-fixes.js — Downgrade LLM confidence on reviews where human thumbs conflict with the LLM score.

Usage:
  node scripts/apply-human-review-fixes.js [options]
  node scripts/apply-human-review-fixes.js --help, -h    print this usage and exit
`;
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

  const fixesPath = path.join(__dirname, '../data/audit/human-review-fixes.json');
  const fixes = JSON.parse(fs.readFileSync(fixesPath, 'utf-8'));

  let applied = 0;
  let skipped = 0;
  let errors = 0;

  for (const fix of fixes.fixes) {
    const showDir = path.join(__dirname, '../data/review-texts', fix.showId);
    if (!fs.existsSync(showDir)) {
      console.log(`SKIP: ${fix.showId}/${fix.outletId} — show dir not found`);
      skipped++;
      continue;
    }

    const target = findFixTarget(showDir, fix);
    if (target.status === 'not-found') {
      console.log(`SKIP: ${fix.showId}/${fix.outletId} — file not found`);
      skipped++;
      continue;
    }
    if (target.status === 'ambiguous') {
      console.log(`SKIP: ${fix.showId}/${fix.outletId} — ambiguous, ${target.candidates.length} same-outlet files (${target.candidates.join(', ')}); add criticName to the fix`);
      skipped++;
      continue;
    }

    try {
      const { filePath, data } = target;
      if (data.llmScore && data.llmScore.confidence !== 'low') {
        const oldConf = data.llmScore.confidence;
        data.llmScore.confidence = 'low';
        data.llmScore.humanReviewOverride = {
          previousConfidence: oldConf,
          reason: fix.reason,
          appliedAt: new Date().toISOString()
        };

        safeWriteReview(filePath, data);
        console.log(`✓ ${fix.showId}/${fix.outletId}: LLM ${data.llmScore.score}(${oldConf}→low) — will use thumb override (${fix.newScore})`);
        applied++;
      } else if (data.llmScore && data.llmScore.confidence === 'low') {
        console.log(`SKIP: ${fix.showId}/${fix.outletId} — already low confidence`);
        skipped++;
      } else {
        console.log(`SKIP: ${fix.showId}/${fix.outletId} — no llmScore to override`);
        skipped++;
      }
    } catch (e) {
      console.log(`ERROR: ${fix.showId}/${fix.outletId} — ${e.message}`);
      errors++;
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Applied: ${applied}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`\nRun 'node scripts/rebuild-all-reviews.js' to rebuild with fixed scores.`);
}

if (require.main === module) main();
