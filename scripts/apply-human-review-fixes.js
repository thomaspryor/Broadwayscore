#!/usr/bin/env node
/**
 * Apply human review fixes
 * For reviews where LLM Pan/Negative scores conflict with Meh/Up thumbs,
 * downgrade LLM confidence to 'low' so thumb override applies in rebuild.
 * For "both thumbs Up" cases where LLM scored too low, same approach.
 */

const fs = require('fs');
const path = require('path');

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

  // Find the review-text file
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  let found = false;

  for (const f of files) {
    try {
      const filePath = path.join(showDir, f);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const outletMatch = (data.outletId || '').toLowerCase() === (fix.outletId || '').toLowerCase();

      if (outletMatch) {
        found = true;

        // Check if this actually needs fixing
        if (data.llmScore && data.llmScore.confidence !== 'low') {
          const oldConf = data.llmScore.confidence;
          data.llmScore.confidence = 'low';
          data.llmScore.humanReviewOverride = {
            previousConfidence: oldConf,
            reason: fix.reason,
            appliedAt: new Date().toISOString()
          };

          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          console.log(`✓ ${fix.showId}/${fix.outletId}: LLM ${data.llmScore.score}(${oldConf}→low) — will use thumb override (${fix.newScore})`);
          applied++;
        } else if (data.llmScore && data.llmScore.confidence === 'low') {
          console.log(`SKIP: ${fix.showId}/${fix.outletId} — already low confidence`);
          skipped++;
        } else {
          console.log(`SKIP: ${fix.showId}/${fix.outletId} — no llmScore to override`);
          skipped++;
        }
        break;
      }
    } catch (e) {
      console.log(`ERROR: ${fix.showId}/${fix.outletId} — ${e.message}`);
      errors++;
    }
  }

  if (!found) {
    console.log(`SKIP: ${fix.showId}/${fix.outletId} — file not found`);
    skipped++;
  }
}

console.log(`\n=== RESULTS ===`);
console.log(`Applied: ${applied}`);
console.log(`Skipped: ${skipped}`);
console.log(`Errors: ${errors}`);
console.log(`\nRun 'node scripts/rebuild-all-reviews.js' to rebuild with fixed scores.`);
