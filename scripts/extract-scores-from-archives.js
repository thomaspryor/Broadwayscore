#!/usr/bin/env node
/**
 * Extract explicit scores from locally archived HTML files.
 *
 * Many review-text files have archivePath (local HTML on disk) but no originalScore.
 * This script reads the archived HTML and runs outlet-specific extractors to recover
 * P0 explicit scores (star ratings, letter grades) without any network requests.
 *
 * Usage:
 *   node scripts/extract-scores-from-archives.js [--execute] [--outlet=guardian] [--limit=10]
 *
 * Options:
 *   --execute    Actually write changes (default: dry run)
 *   --outlet=X   Only process one outlet
 *   --limit=N    Process at most N reviews
 */

const fs = require('fs');
const path = require('path');

const { extractScore, OUTLET_EXTRACTORS } = require('./lib/score-extractors');
const { parseOriginalScore } = require('./lib/score-parsers');
const { AGGREGATOR_SCORE_SOURCES } = require('./lib/review-normalization');

const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const execute = process.argv.includes('--execute');
const outletFilter = (process.argv.find(a => a.startsWith('--outlet=')) || '').split('=')[1] || null;
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : Infinity;

// Only process outlets that have dedicated extractors
const TARGET_OUTLETS = new Set(Object.keys(OUTLET_EXTRACTORS).filter(k => {
  const fn = OUTLET_EXTRACTORS[k];
  return fn && fn.name !== 'noScoreExtractor';
}));

console.log(`\n=== Archive Score Extraction ${execute ? '(EXECUTING)' : '(DRY RUN)'} ===`);
if (outletFilter) console.log(`Filtering to outlet: ${outletFilter}`);
console.log(`Outlets with extractors: ${TARGET_OUTLETS.size}`);
console.log('');

const showDirs = fs.readdirSync(REVIEW_DIR).filter(d =>
  fs.statSync(path.join(REVIEW_DIR, d)).isDirectory()
);

let processed = 0, extracted = 0, failed = 0, skipped = 0;
const perOutlet = {};

for (const dir of showDirs) {
  if (processed >= limit) break;
  const showDir = path.join(REVIEW_DIR, dir);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    if (processed >= limit) break;
    const outletId = file.split('--')[0];

    // Filter checks
    if (outletFilter && outletId !== outletFilter) continue;
    if (!TARGET_OUTLETS.has(outletId)) continue;

    const fp = path.join(showDir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (e) { continue; }

    // Skip if already has originalScore
    if (data.originalScore) continue;

    // Skip if no archive path
    if (!data.archivePath) continue;

    // Resolve archive path
    const archivePath = path.join(__dirname, '..', data.archivePath);
    if (!fs.existsSync(archivePath)) {
      skipped++;
      continue;
    }

    processed++;

    // Read archived HTML
    let html;
    try {
      html = fs.readFileSync(archivePath, 'utf8');
    } catch (e) {
      skipped++;
      continue;
    }

    if (!html || html.length < 100) {
      skipped++;
      continue;
    }

    // Try to extract score using outlet-specific extractor
    const text = data.fullText || '';
    const result = extractScore(html, text, outletId);

    if (!perOutlet[outletId]) perOutlet[outletId] = { checked: 0, found: 0, samples: [] };
    perOutlet[outletId].checked++;

    if (result && result.originalScore) {
      extracted++;
      perOutlet[outletId].found++;

      if (perOutlet[outletId].samples.length < 3) {
        perOutlet[outletId].samples.push({
          file: `${dir}/${file}`,
          score: result.originalScore,
          normalized: result.normalizedScore
        });
      }

      if (execute) {
        if (AGGREGATOR_SCORE_SOURCES.has(result.source)) {
          data.aggregatorStars = result.originalScore;
        } else {
          data.originalScore = result.originalScore;
        }
        data.originalScoreNormalized = result.normalizedScore;
        data._scoreNote = `Extracted from archived HTML (${new Date().toISOString().split('T')[0]})`;
        fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
      }
    } else {
      failed++;
    }
  }
}

console.log('=== Per-Outlet Results ===');
const sortedOutlets = Object.entries(perOutlet).sort((a, b) => b[1].found - a[1].found);
for (const [outlet, stats] of sortedOutlets) {
  const pct = stats.checked > 0 ? (stats.found / stats.checked * 100).toFixed(0) : 0;
  console.log(`${outlet}: ${stats.found}/${stats.checked} extracted (${pct}%)`);
  stats.samples.forEach(s => console.log(`    ${s.file}: ${s.score} → ${s.normalized}`));
}

console.log(`\n=== SUMMARY ===`);
console.log(`Processed: ${processed} | Extracted: ${extracted} | No score found: ${failed} | Skipped (no archive): ${skipped}`);
if (!execute) {
  console.log('\nDRY RUN — no changes. Use --execute to apply.');
} else {
  console.log(`\n${extracted} scores extracted from archives. Run rebuild next.`);
}
