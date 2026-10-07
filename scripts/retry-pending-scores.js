#!/usr/bin/env node
/**
 * Phase 3b: Retry score extraction for reviews with scoreExtractionPending: true
 *
 * Finds review files where:
 *   - scoreExtractionPending is true
 *   - originalScore is not set
 *   - fullText exists (>200 chars)
 *
 * Runs them through extractExplicitScore() and clears the pending flag.
 *
 * Usage:
 *   node scripts/retry-pending-scores.js --dry-run     # Preview what would be retried
 *   node scripts/retry-pending-scores.js               # Run retries
 *   node scripts/retry-pending-scores.js --limit=50    # Limit to first 50
 */

const fs = require('fs');
const path = require('path');
const { extractExplicitScore } = require('./lib/llm-score-extractor');
const { setExtractedScore } = require('./lib/score-routing');
const { OUTLET_EXTRACTORS } = require('./lib/score-extractors');

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : Infinity;

const reviewTextsDir = path.join(__dirname, '..', 'data', 'review-texts');

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const allFiles = walkDir(reviewTextsDir);
  console.log(`Scanning ${allFiles.length} review files for pending score extraction...\n`);

  const pending = [];
  for (const filePath of allFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // Skip files we already tried explicit extraction on — once extraction
      // has failed, re-running it will just fail again. The file is now the
      // LLM ensemble scorer's responsibility (picked up via !llmScore filter).
      if (data.explicitExtractionTried) continue;
      if (data.scoreExtractionPending && !data.originalScore && data.fullText && data.fullText.length > 200) {
        // Skip outlets that are marked noScoreExtractor — clear the pending flag and move on
        const outletId = (data.outletId || '').toLowerCase();
        const extractor = OUTLET_EXTRACTORS[outletId];
        if (extractor && extractor.name === 'noScoreExtractor') {
          delete data.scoreExtractionPending;
          data.explicitExtractionTried = true;
          data.explicitExtractionTriedAt = new Date().toISOString();
          data.explicitExtractionReason = 'noScoreExtractor';
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          continue;
        }
        pending.push({ filePath, data });
      }
    } catch (e) { /* skip unreadable */ }
  }

  console.log(`Found ${pending.length} pending files`);
  if (DRY_RUN) {
    for (const { filePath } of pending.slice(0, 20)) {
      console.log(`  Would retry: ${path.relative(reviewTextsDir, filePath)}`);
    }
    if (pending.length > 20) console.log(`  ... and ${pending.length - 20} more`);
    return;
  }

  const toProcess = pending.slice(0, LIMIT);
  let found = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { filePath, data } = toProcess[i];
    const rel = path.relative(reviewTextsDir, filePath);

    try {
      const result = await extractExplicitScore({
        text: data.fullText,
        outletId: data.outletId || '',
        verbose: VERBOSE
      });

      if (result) {
        // Routes to originalScore unless EITHER the incoming source OR the
        // file's existing scoreSource is an aggregator. See lib/score-routing.js.
        const routed = setExtractedScore(data, {
          value: result.originalScore,
          normalizedValue: result.normalizedScore,
          source: result.source,
        });
        delete data.scoreExtractionPending;
        data.explicitExtractionTried = true;
        data.explicitExtractionTriedAt = new Date().toISOString();
        data.explicitExtractionReason = 'found';
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        found++;
        console.log(`  [${i + 1}/${toProcess.length}] ✓ ${rel}: ${result.originalScore} (${result.normalizedScore}) → ${routed.field}`);
      } else {
        // Explicit extraction failed — no stars, letter grade, or numeric rating
        // in the text. DO NOT silently orphan the file: clear the pending flag
        // so retry-pending-scores doesn't re-process it (explicit extraction
        // will fail every time for the same text), but leave the file visible
        // to the LLM ensemble scorer. The scorer picks up files via !llmScore
        // so we don't need to set a positive marker — the absence of llmScore
        // after this pass is enough.
        //
        // Historical bug (2026-04-11): this block used to simply `delete
        // data.scoreExtractionPending` with no marker. When the LLM ensemble
        // scheduler's 5-review threshold rejected small batches, those files
        // sat unscored indefinitely — 70 orphans accumulated across 57 shows
        // with a median age of 57 days.
        delete data.scoreExtractionPending;
        data.explicitExtractionTried = true;
        data.explicitExtractionTriedAt = new Date().toISOString();
        data.explicitExtractionReason = 'no-explicit-rating-found';
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        notFound++;
        if (VERBOSE) console.log(`  [${i + 1}/${toProcess.length}] - ${rel}: no score found (LLM ensemble will handle)`);
      }

      // Rate limit: 0.5s between Gemini calls
      await new Promise(r => setTimeout(r, 500));

    } catch (e) {
      errors++;
      console.error(`  [${i + 1}/${toProcess.length}] ✗ ${rel}: ${e.message}`);
    }
  }

  console.log(`\n=== Retry Complete ===`);
  console.log(`  Processed: ${toProcess.length}`);
  console.log(`  Scores found: ${found}`);
  console.log(`  No score: ${notFound}`);
  console.log(`  Errors: ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
