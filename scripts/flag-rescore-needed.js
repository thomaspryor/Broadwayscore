#!/usr/bin/env node
/**
 * Flag reviews that need rescoring
 *
 * Identifies reviews that:
 * - Have fullText (>500 chars)
 * - Have llmScore
 * - LLM score was likely based on excerpt (keyPhrases are short snippets)
 *
 * Sets needsRescore=true for these reviews
 */

const fs = require('fs');
const path = require('path');

const reviewDir = 'data/review-texts';
const shows = fs.readdirSync(reviewDir).filter(f => {
  const fullPath = path.join(reviewDir, f);
  // Skip symlinks to avoid processing the same directory twice
  if (fs.lstatSync(fullPath).isSymbolicLink()) return false;
  return fs.statSync(fullPath).isDirectory();
});

let flagged = 0;
let skipped = 0;
let alreadyFlagged = 0;
let noFullText = 0;
let noLlmScore = 0;

const flaggedReviews = [];

console.log('='.repeat(70));
console.log('FLAGGING REVIEWS THAT NEED RESCORING');
console.log('='.repeat(70));
console.log('\nLooking for reviews scored on excerpts that now have fullText...\n');

for (const show of shows) {
  const showDir = path.join(reviewDir, show);
  const files = fs.readdirSync(showDir).filter(f =>
    f.endsWith('.json') && f !== 'failed-fetches.json'
  );

  for (const file of files) {
    const filePath = path.join(showDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Skip if already flagged
      if (data.needsRescore) {
        alreadyFlagged++;
        continue;
      }

      // Skip if no fullText
      if (!data.fullText || data.fullText.length < 500) {
        noFullText++;
        continue;
      }

      // Skip if no llmScore
      if (!data.llmScore || !data.llmScore.score) {
        noLlmScore++;
        continue;
      }

      // Check if score was based on excerpt by looking at keyPhrases
      // If keyPhrases are very short or reasoning mentions "brief excerpt", it's excerpt-based
      const keyPhrases = data.llmScore.keyPhrases || [];
      const reasoning = data.llmScore.reasoning || '';

      // Indicators of excerpt-based scoring:
      // 1. Reasoning mentions "brief" or "short" or "excerpt"
      // 2. Total keyPhrase text is <200 chars
      // 3. Only 1-2 keyPhrases
      const totalKeyPhraseLength = keyPhrases.reduce((sum, kp) => sum + (kp.quote || '').length, 0);
      const isExcerptBased =
        reasoning.toLowerCase().includes('brief') ||
        reasoning.toLowerCase().includes('short excerpt') ||
        reasoning.toLowerCase().includes('very brief') ||
        totalKeyPhraseLength < 200 ||
        keyPhrases.length <= 2;

      // Also check: if fullText is 3x+ longer than longest excerpt, probably needs rescore
      const excerptLength = Math.max(
        (data.dtliExcerpt || '').length,
        (data.bwwExcerpt || '').length,
        (data.showScoreExcerpt || '').length
      );
      const fullTextMuchLonger = data.fullText.length > excerptLength * 3 && excerptLength > 0;

      if (isExcerptBased || fullTextMuchLonger) {
        // Flag for rescore
        data.needsRescore = true;
        data.rescoreReason = isExcerptBased
          ? 'scored on brief excerpt, now has fullText'
          : 'fullText significantly longer than excerpt used for scoring';
        data.previousLlmScore = data.llmScore.score;

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        flagged++;
        flaggedReviews.push({
          show,
          file,
          score: data.llmScore.score,
          fullTextLength: data.fullText.length,
          excerptLength,
          reason: data.rescoreReason
        });
      } else {
        skipped++;
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
}

console.log('='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log(`\nTotal reviews flagged for rescore: ${flagged}`);
console.log(`Already flagged: ${alreadyFlagged}`);
console.log(`Skipped (score appears fullText-based): ${skipped}`);
console.log(`No fullText: ${noFullText}`);
console.log(`No llmScore: ${noLlmScore}`);

if (flaggedReviews.length > 0) {
  console.log('\n--- Flagged Reviews (sample) ---\n');
  for (const r of flaggedReviews.slice(0, 20)) {
    console.log(`${r.show}/${r.file}:`);
    console.log(`  score: ${r.score}, fullText: ${r.fullTextLength} chars, excerpt: ${r.excerptLength} chars`);
    console.log(`  reason: ${r.reason}`);
  }
  if (flaggedReviews.length > 20) {
    console.log(`\n... and ${flaggedReviews.length - 20} more`);
  }
}

// Save full list to audit file
const auditPath = 'data/audit/rescore-needed.json';
fs.writeFileSync(auditPath, JSON.stringify({
  flaggedAt: new Date().toISOString(),
  totalFlagged: flagged,
  reviews: flaggedReviews
}, null, 2));
console.log(`\nFull list saved to: ${auditPath}`);
