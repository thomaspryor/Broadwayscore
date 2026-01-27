#!/usr/bin/env node
/**
 * Audit existing reviews for truncation signals
 * Flags reviews that may have been incorrectly marked as "full" but are actually truncated
 */

const fs = require('fs');
const path = require('path');

const reviewTextsDir = 'data/review-texts';

// Same truncation detection as in collect-review-texts.js
function detectTruncationSignals(text, excerptLength = 0) {
  if (!text || text.trim().length === 0) {
    return { signals: [], likelyTruncated: false };
  }

  const signals = [];
  const trimmedText = text.trim();
  const lastChar = trimmedText.slice(-1);
  const last500 = trimmedText.slice(-500).toLowerCase();

  // Check for proper sentence ending
  const endsWithPunctuation = /[.!?"'"\)]$/.test(trimmedText);
  if (!endsWithPunctuation) {
    signals.push('no_ending_punctuation');
  }

  // Check for ellipsis ending
  if (/\.{3}$|…$/.test(trimmedText)) {
    signals.push('ends_with_ellipsis');
  }

  // Check for paywall/subscribe text near end
  if (/subscribe|sign.?in|log.?in|create.?account|members?.?only/i.test(last500)) {
    signals.push('has_paywall_text');
  }

  // Check for "read more" or "continue reading"
  if (/continue.?reading|read.?more|read.?the.?full|full.?article|full.?review/i.test(last500)) {
    signals.push('has_read_more_prompt');
  }

  // Check for common paywall endings
  if (/privacy.?policy|terms.?of.?use|all.?rights.?reserved|©/i.test(last500)) {
    signals.push('has_footer_text');
  }

  // Check if text is suspiciously short compared to excerpt
  if (excerptLength > 100 && text.length < excerptLength * 1.5) {
    signals.push('shorter_than_excerpt');
  }

  // Check for mid-word cutoff (ends with lowercase letter, no punctuation)
  if (/[a-z]$/.test(lastChar) && !endsWithPunctuation) {
    signals.push('possible_mid_word_cutoff');
  }

  // Determine if likely truncated based on signals
  const severeSignals = ['has_paywall_text', 'has_read_more_prompt', 'ends_with_ellipsis', 'shorter_than_excerpt'];
  const hasSevereSignal = signals.some(s => severeSignals.includes(s));
  const likelyTruncated = hasSevereSignal || signals.length >= 2;

  return { signals, likelyTruncated };
}

// Main audit
const shows = fs.readdirSync(reviewTextsDir).filter(f => {
  return fs.statSync(path.join(reviewTextsDir, f)).isDirectory();
});

let totalReviews = 0;
let reviewsWithText = 0;
let markedFull = 0;
let actuallyTruncated = 0;
const flaggedReviews = [];

const signalCounts = {};

for (const show of shows) {
  const showDir = path.join(reviewTextsDir, show);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    const filePath = path.join(showDir, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    totalReviews++;

    if (!data.fullText || data.fullText.length < 100) continue;
    reviewsWithText++;

    // Get excerpt length
    const excerptLength = Math.max(
      (data.dtliExcerpt || '').length,
      (data.bwwExcerpt || '').length,
      (data.showScoreExcerpt || '').length
    );

    // Detect truncation
    const { signals, likelyTruncated } = detectTruncationSignals(data.fullText, excerptLength);

    // Count signals
    signals.forEach(s => {
      signalCounts[s] = (signalCounts[s] || 0) + 1;
    });

    // Check if marked as full but actually truncated
    const wasMarkedFull = data.textQuality === 'full' || data.textStatus === 'complete';
    if (wasMarkedFull) markedFull++;

    if (likelyTruncated) {
      actuallyTruncated++;
      if (wasMarkedFull) {
        flaggedReviews.push({
          file: `${show}/${file}`,
          outlet: data.outlet,
          signals,
          wordCount: data.textWordCount || data.fullText.split(/\s+/).length,
          charCount: data.fullText.length,
          excerptLength,
          ending: data.fullText.slice(-100).trim()
        });
      }
    }
  }
}

console.log('=== Truncation Audit Results ===\n');
console.log('Total reviews:', totalReviews);
console.log('Reviews with text:', reviewsWithText);
console.log('Marked as full/complete:', markedFull);
console.log('Actually truncated:', actuallyTruncated, `(${(actuallyTruncated/reviewsWithText*100).toFixed(1)}%)`);
console.log('');
console.log('FALSE POSITIVES (marked full but truncated):', flaggedReviews.length);
console.log('');

console.log('=== Signal Frequency ===');
Object.entries(signalCounts)
  .sort((a, b) => b[1] - a[1])
  .forEach(([signal, count]) => {
    console.log(`  ${signal}: ${count} (${(count/reviewsWithText*100).toFixed(1)}%)`);
  });

if (flaggedReviews.length > 0) {
  console.log('\n=== Flagged Reviews (marked full but truncated) ===\n');

  // Group by signal type
  const bySignal = {};
  flaggedReviews.forEach(r => {
    r.signals.forEach(s => {
      if (!bySignal[s]) bySignal[s] = [];
      bySignal[s].push(r);
    });
  });

  // Show examples for each signal type
  Object.entries(bySignal).forEach(([signal, reviews]) => {
    console.log(`\n--- ${signal} (${reviews.length} reviews) ---`);
    reviews.slice(0, 3).forEach(r => {
      console.log(`  ${r.file}`);
      console.log(`    Outlet: ${r.outlet}, Words: ${r.wordCount}, Chars: ${r.charCount}`);
      console.log(`    Ending: "...${r.ending.slice(-60)}"`);
    });
    if (reviews.length > 3) {
      console.log(`    ... and ${reviews.length - 3} more`);
    }
  });

  // Save full list to file
  const outputPath = 'data/audit/truncated-reviews-to-fix.json';
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(flaggedReviews, null, 2));
  console.log(`\n✓ Full list saved to ${outputPath}`);
}
