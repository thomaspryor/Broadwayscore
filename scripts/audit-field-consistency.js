#!/usr/bin/env node
/**
 * audit-field-consistency.js
 *
 * Detects and optionally fixes metadata drift across review source files.
 * Checks: wordCount, isFullReview, textStatus, textQuality vs contentTier,
 *         contentTier=complete without fullText, stub+score anomalies.
 *
 * Usage:
 *   node scripts/audit-field-consistency.js              # dry-run report
 *   node scripts/audit-field-consistency.js --fix        # fix all auto-fixable issues
 *   node scripts/audit-field-consistency.js --fix --verbose
 */

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..', 'data', 'review-texts');
const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const VERBOSE = args.includes('--verbose');

// contentTier is authoritative. Legacy fields (textStatus, textQuality, isFullReview)
// should be synced to match. rebuild-all-reviews.js reads textStatus at lines 492
// (guards excerpt extraction) and 2359 (guards excerpt-fullText comparison), so
// correct mapping is critical.
//
// textStatus legacy values: complete, partial, full, incomplete, truncated
// textQuality legacy values: full, truncated, partial, excerpt, stub
const TIER_TO_TEXTSTATUS = {
  complete: 'complete',
  truncated: 'truncated',
  excerpt: 'incomplete',    // no fullText, only aggregator excerpts
  stub: 'incomplete',       // no usable text
  // invalid/needs-rescrape: skip — mixed provenance, don't overwrite
};

const TIER_TO_TEXTQUALITY = {
  complete: 'full',
  truncated: 'truncated',
  excerpt: 'excerpt',
  stub: 'stub',
  // invalid/needs-rescrape: skip
};

// Aggregator score sources that legitimately exist on stubs
const AGGREGATOR_SCORE_SOURCES = new Set([
  'stagedoor-star-rating', 'westendtheatre-star-rating', 'thestage-roundup-star-rating',
  'lbo-star-rating', 'theatre-reviews-star-rating', 'show-score-stars',
  'unicode-stars', 'explicit-rating', 'json-ld', 'telegraph-svg-stars',
  'lbo-css-stars', 'guardian-api', 'letter-grade',
]);

const issues = {
  wordCount_zero: [],
  wordCount_drift: [],
  isFullReview_stale: [],
  textStatus_mismatch: [],
  textQuality_mismatch: [],
  contentTier_complete_no_text: [],
  contentTier_stub_suspicious_score: [],
};

let totalFiles = 0;
let fixedFiles = 0;

for (const showDir of fs.readdirSync(BASE)) {
  const showPath = path.join(BASE, showDir);
  if (!fs.statSync(showPath).isDirectory()) continue;

  for (const fname of fs.readdirSync(showPath)) {
    if (!fname.endsWith('.json')) continue;
    const fpath = path.join(showPath, fname);
    totalFiles++;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(fpath, 'utf8'));
    } catch {
      continue;
    }

    const rel = `${showDir}/${fname}`;
    let modified = false;

    // --- 1. wordCount ---
    const fullText = data.fullText || '';
    const actualWc = fullText.trim() ? fullText.split(/\s+/).length : 0;

    if (data.wordCount !== undefined) {
      if (data.wordCount === 0 && actualWc > 0) {
        issues.wordCount_zero.push(rel);
        if (FIX) { data.wordCount = actualWc; modified = true; }
      } else if (actualWc > 0 && Math.abs(actualWc - data.wordCount) > Math.max(5, actualWc * 0.1)) {
        issues.wordCount_drift.push({ file: rel, stored: data.wordCount, actual: actualWc });
        if (FIX) { data.wordCount = actualWc; modified = true; }
      }
    }

    // --- 2. isFullReview vs contentTier ---
    if (data.isFullReview === true && data.contentTier && data.contentTier !== 'complete') {
      issues.isFullReview_stale.push({ file: rel, contentTier: data.contentTier });
      if (FIX) { data.isFullReview = false; modified = true; }
    }
    // Also sync the reverse: isFullReview=false but contentTier=complete
    if (data.isFullReview === false && data.contentTier === 'complete') {
      issues.isFullReview_stale.push({ file: rel, contentTier: 'complete', note: 'should be true' });
      if (FIX) { data.isFullReview = true; modified = true; }
    }

    // --- 3. textStatus vs contentTier ---
    if (data.textStatus && data.contentTier) {
      const expected = TIER_TO_TEXTSTATUS[data.contentTier];
      if (expected && data.textStatus !== expected) {
        issues.textStatus_mismatch.push({ file: rel, textStatus: data.textStatus, contentTier: data.contentTier });
        if (FIX) { data.textStatus = expected; modified = true; }
      }
    }

    // --- 4. textQuality vs contentTier ---
    if (data.textQuality && data.contentTier) {
      const expected = TIER_TO_TEXTQUALITY[data.contentTier];
      if (expected && data.textQuality !== expected) {
        issues.textQuality_mismatch.push({ file: rel, textQuality: data.textQuality, contentTier: data.contentTier });
        if (FIX) { data.textQuality = expected; modified = true; }
      }
    }

    // --- 5. contentTier=complete but no fullText ---
    if (data.contentTier === 'complete' && (!fullText || !fullText.trim())) {
      issues.contentTier_complete_no_text.push(rel);
      if (FIX) { data.contentTier = 'stub'; modified = true; }
    }

    // --- 6. contentTier=stub with assignedScore from non-aggregator source ---
    if (data.contentTier === 'stub' && data.assignedScore != null) {
      const src = data.scoreSource || '';
      if (!AGGREGATOR_SCORE_SOURCES.has(src)) {
        issues.contentTier_stub_suspicious_score.push({ file: rel, scoreSource: src });
        // Don't auto-fix scores — flag for manual review
      }
    }

    if (modified) {
      fs.writeFileSync(fpath, JSON.stringify(data, null, 2) + '\n');
      fixedFiles++;
      if (VERBOSE) console.log(`  fixed: ${rel}`);
    }
  }
}

// --- Report ---
console.log(`\nField Consistency Audit — ${totalFiles} files scanned\n`);

const categories = [
  ['wordCount=0 (should match fullText)', issues.wordCount_zero],
  ['wordCount drift (>10% off actual)', issues.wordCount_drift],
  ['isFullReview stale (disagrees with contentTier)', issues.isFullReview_stale],
  ['textStatus ≠ contentTier', issues.textStatus_mismatch],
  ['textQuality ≠ contentTier', issues.textQuality_mismatch],
  ['contentTier=complete but no fullText', issues.contentTier_complete_no_text],
  ['contentTier=stub with suspicious assignedScore', issues.contentTier_stub_suspicious_score],
];

let totalIssues = 0;
for (const [label, items] of categories) {
  if (items.length === 0) continue;
  totalIssues += items.length;
  console.log(`${items.length} — ${label}`);
  if (VERBOSE) {
    for (const item of items.slice(0, 10)) {
      console.log(`  ${typeof item === 'string' ? item : JSON.stringify(item)}`);
    }
    if (items.length > 10) console.log(`  ... and ${items.length - 10} more`);
  }
}

if (totalIssues === 0) {
  console.log('No field consistency issues found.');
} else {
  console.log(`\nTotal: ${totalIssues} issues across ${categories.filter(c => c[1].length > 0).length} categories`);
}

if (FIX) {
  console.log(`\nFixed ${fixedFiles} files (stub+suspicious-score not auto-fixed — needs manual review)`);
} else if (totalIssues > 0) {
  console.log('\nRun with --fix to auto-correct.');
}
