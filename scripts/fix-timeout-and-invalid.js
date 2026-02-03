#!/usr/bin/env node
/**
 * One-time fix script: Clean Time Out newsletter junk from fullText
 * and reclassify misclassified "invalid" reviews.
 *
 * Uses the centralized cleanText() from text-cleaning.js (which now has
 * Time Out and Chicago Tribune patterns) so the same logic applies to
 * both existing and future reviews.
 */

const fs = require('fs');
const path = require('path');
const { classifyContentTier } = require('./lib/content-quality');
const { cleanText } = require('./lib/text-cleaning');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Misclassified reviews to fix (false positive invalid classification)
// NOTE: wrongProduction files (stranger-things, two-strangers, suffs, purlie-victorious)
// are correctly classified as invalid and excluded from this list.
const MISCLASSIFIED_FILES = [
  'the-great-gatsby-2024/chicagotribune--chris-jones.json',   // embedded JS triggers paywall detection
  'marjorie-prime-2025/chicagotribune--chris-jones.json',      // embedded JS triggers paywall detection
  'doubt-2024/nydailynews--chris-jones.json',                  // "has been removed" in review context
  'the-notebook-2024/indiewire--erin-strecker.json',           // IndieWire boilerplate at start
];

function fixReviewFile(filePath, label) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (data.contentTier !== 'invalid' && data.contentTier !== undefined && data.contentTier !== null) {
    console.log(`  SKIP ${label} - already ${data.contentTier}`);
    return null;
  }

  if (!data.fullText) {
    console.log(`  SKIP ${label} - no fullText`);
    return null;
  }

  const originalText = data.fullText;
  const originalWordCount = originalText.split(/\s+/).filter(w => w).length;

  // Apply centralized cleaning (now includes Time Out and Chicago Tribune patterns)
  const cleaned = cleanText(originalText);

  if (cleaned.length < 100) {
    console.log(`  SKIP ${label} - cleaned text too short (${cleaned.length} chars)`);
    return null;
  }

  const cleanedWordCount = cleaned.split(/\s+/).filter(w => w).length;

  data.fullText = cleaned;
  data.wordCount = cleanedWordCount;
  data.textWordCount = cleanedWordCount;

  // Reclassify content tier (classifyContentTier takes the full review object)
  const tierResult = classifyContentTier(data);

  const oldTier = data.contentTier;
  const oldReason = data.tierReason;
  data.contentTier = tierResult.contentTier;
  data.tierReason = tierResult.tierReason || null;
  data.textQuality = cleanedWordCount > 300 ? 'full' : cleanedWordCount > 150 ? 'partial' : data.textQuality;
  data.isFullReview = cleanedWordCount >= 300;

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');

  console.log(`  FIXED ${label}: ${originalWordCount}→${cleanedWordCount} words, ${oldTier}→${data.contentTier} (reason: ${oldReason || 'no reason'})`);
  return { file: label, newTier: data.contentTier, wordsRemoved: originalWordCount - cleanedWordCount };
}

async function main() {
  const changes = [];

  // ── Fix Time Out reviews ──
  console.log('=== Fixing Time Out newsletter junk (29 invalid reviews) ===');

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    const p = path.join(REVIEW_TEXTS_DIR, d);
    return fs.statSync(p).isDirectory();
  });

  for (const showDir of showDirs) {
    const dirPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(dirPath).filter(f => f.startsWith('timeout--') && f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Match files that were invalid or got undefined from previous broken run
      if (data.contentTier !== 'invalid' && data.contentTier !== undefined && data.contentTier !== null) continue;
      if (!data.fullText) continue;

      const result = fixReviewFile(filePath, `${showDir}/${file}`);
      if (result) changes.push({ ...result, type: 'timeout-cleanup' });
    }
  }

  // ── Fix misclassified reviews ──
  console.log('\n=== Fixing misclassified invalid reviews ===');

  for (const relPath of MISCLASSIFIED_FILES) {
    const filePath = path.join(REVIEW_TEXTS_DIR, relPath);

    if (!fs.existsSync(filePath)) {
      console.log(`  SKIP ${relPath} - file not found`);
      continue;
    }

    const result = fixReviewFile(filePath, relPath);
    if (result) changes.push({ ...result, type: 'misclassified-fix' });
  }

  console.log(`\n=== Summary ===`);
  const timeoutCount = changes.filter(c => c.type === 'timeout-cleanup').length;
  const misclassifiedCount = changes.filter(c => c.type === 'misclassified-fix').length;
  console.log(`Time Out reviews cleaned: ${timeoutCount}`);
  console.log(`Misclassified reviews fixed: ${misclassifiedCount}`);
  console.log(`Total changes: ${changes.length}`);

  if (changes.length > 0) {
    console.log('\nAll changes:');
    for (const c of changes) {
      console.log(`  [${c.type}] ${c.file} → ${c.newTier} (removed ${c.wordsRemoved} junk words)`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
