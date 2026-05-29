#!/usr/bin/env node
/**
 * Reconcile source file scores with star ratings and clean up known bad data.
 *
 * Fixes two classes of source file issues:
 *
 * Bug A: star-icon originalScore is unreliable (57 Timeout files from
 *   BWW/Playbill Verdict listing pages where a greedy regex matched random
 *   numbers near star-themed CSS classes). Clears the bad originalScore and
 *   marks scoreSource as 'star-icon-unreliable'.
 *
 * Bug B: assignedScore doesn't match originalScore (332 files where the
 *   score was set by an early pipeline pass, then originalScore was extracted
 *   later but assignedScore was never updated). Updates assignedScore to match
 *   the star-to-score conversion.
 *
 * NOTE: The rebuild already handles both correctly (star-icon skipped at P0.5,
 * originalScore used at P0.5 over assignedScore at P4b). This script is for
 * source file hygiene — making the data less misleading for debugging.
 *
 * Usage:
 *   node scripts/reconcile-source-scores.js --dry-run
 *   node scripts/reconcile-source-scores.js
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const dryRun = process.argv.includes('--dry-run');

// Star-to-score lookup (matches score-conversion-rules.js)
const STARS_OUT_OF_5 = {
  5: 100, 4.5: 90, 4: 80, 3.5: 70, 3: 60,
  2.5: 50, 2: 40, 1.5: 30, 1: 20, 0.5: 10, 0: 0
};

function convertStarRating(originalScore) {
  if (!originalScore || typeof originalScore !== 'string') return null;
  const m = originalScore.match(/^([\d.]+)\s*\/\s*([\d.]+)$/);
  if (!m) return null;
  const stars = parseFloat(m[1]);
  const outOf = parseFloat(m[2]);
  if (outOf === 5 && STARS_OUT_OF_5[stars] !== undefined) return STARS_OUT_OF_5[stars];
  if (outOf > 0) return Math.round((stars / outOf) * 100);
  return null;
}

let stats = { bugA: 0, bugB: 0, skipped: 0, total: 0 };

for (const show of listShowDirs(REVIEW_TEXTS_DIR)) {
  const showDir = path.join(REVIEW_TEXTS_DIR, show);
  if (!fs.statSync(showDir).isDirectory()) continue;

  for (const file of fs.readdirSync(showDir).filter(f => f.endsWith('.json'))) {
    const filePath = path.join(showDir, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (data.wrongShow || data.wrongProduction) continue;
    stats.total++;

    let modified = false;

    // Bug A: Clear unreliable star-icon originalScore
    if (data.scoreSource === 'star-icon') {
      const expected = convertStarRating(data.originalScore || '');
      const llm = data.llmScore?.score;

      // If LLM contradicts the star-icon by >25 pts, the star-icon is wrong
      if (expected && llm && Math.abs(expected - llm) > 25) {
        if (!dryRun) {
          data._starIconOriginalScore = data.originalScore; // preserve for audit
          data.originalScore = null;
          data.scoreSource = 'star-icon-cleared';
          data.scoreConfidence = 'low';
        }
        stats.bugA++;
        modified = true;
        console.log(`[A] ${show}/${file}: star-icon ${data._starIconOriginalScore || data.originalScore} contradicts LLM ${llm} — cleared`);
      }
    }

    // Bug B: Reconcile assignedScore from originalScore
    // Only when LLM agrees with the star direction (same bucket), or no LLM exists.
    // This prevents overwriting a correct LLM-derived score with a bad star extraction.
    if (data.originalScore && data.assignedScore != null && data.scoreSource !== 'star-icon') {
      const expected = convertStarRating(data.originalScore);
      if (expected !== null) {
        const diff = Math.abs(data.assignedScore - expected);
        if (diff > 10) {
          const llm = data.llmScore?.score;
          const starBucket = expected >= 70 ? 'positive' : expected <= 40 ? 'negative' : 'mixed';
          const llmBucket = llm ? (llm >= 70 ? 'positive' : llm <= 40 ? 'negative' : 'mixed') : null;

          // Safe to reconcile if:
          // 1. No LLM (star rating is only signal), OR
          // 2. LLM agrees with star bucket, OR
          // 3. LLM is within 15 pts of expected (close enough)
          const llmAgrees = !llm || starBucket === llmBucket || Math.abs(expected - llm) <= 15;

          if (llmAgrees) {
            if (!dryRun) {
              data._previousAssignedScore = data.assignedScore;
              data.assignedScore = expected;
            }
            stats.bugB++;
            modified = true;
            console.log(`[B] ${show}/${file}: ${data.originalScore}→${expected}, was ${data.assignedScore} (off by ${diff})${llm ? ` [LLM: ${llm}]` : ''}`);
          } else {
            stats.skipped++;
            if (dryRun) {
              console.log(`[B-SKIP] ${show}/${file}: ${data.originalScore}→${expected} vs LLM ${llm} — buckets disagree (star=${starBucket}, llm=${llmBucket})`);
            }
          }
        }
      }
    }

    if (modified && !dryRun) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    }
  }
}

console.log(`\n${dryRun ? '=== DRY RUN ===' : '=== DONE ==='}`);
console.log(`Scanned: ${stats.total} files`);
console.log(`Bug A (star-icon cleared): ${stats.bugA}`);
console.log(`Bug B (assignedScore reconciled): ${stats.bugB}`);
