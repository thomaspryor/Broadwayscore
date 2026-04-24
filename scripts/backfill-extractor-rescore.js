#!/usr/bin/env node

/**
 * Backfill: re-run outlet-specific extractScore() on review-text files that
 * have complete fullText but a null originalScore or an aggregator-sourced
 * score that should have been superseded by the outlet's own rating.
 *
 * Fixes the class bug surfaced by Rocky Horror 2026-04-23 opening night:
 * NYSR files landed with originalScore=null even though the review HTML
 * contained explicit ★★☆☆☆. The first extractor pass in collect-review-texts
 * skipped re-extraction when originalScore was already set from an aggregator,
 * and the extractor never ran again against the authoritative outlet HTML.
 *
 * Strategy per file:
 *   1. Filter to affected outlets (outlets with a dedicated OUTLET_EXTRACTORS entry)
 *   2. Keep only contentTier=complete + (originalScore=null OR scoreSource is
 *      aggregator-sourced / not in OUTLET_VERIFIED_SOURCES)
 *   3. Load archived HTML if data.archivePath points to an existing file
 *   4. Run extractScore(archivedHtml, fullText, outletId)
 *   5. If non-null result, propose a patch (dry-run) or write it (--write)
 *
 * Usage:
 *   node scripts/backfill-extractor-rescore.js                       # dry-run (default)
 *   node scripts/backfill-extractor-rescore.js --write                # apply patches
 *   node scripts/backfill-extractor-rescore.js --show=the-rocky-...  # single show
 *   node scripts/backfill-extractor-rescore.js --outlet=nysr          # single outlet
 *   node scripts/backfill-extractor-rescore.js --limit=50             # cap file count
 */

const fs = require('fs');
const path = require('path');
const { extractScore, OUTLET_EXTRACTORS, OUTLET_VERIFIED_SOURCES } = require('./lib/score-extractors');
const { AGGREGATOR_SCORE_SOURCES } = require('./lib/score-routing');

const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const ARCHIVES_DIR = path.join(__dirname, '../data/archives/reviews');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || null;
const OUTLET_FILTER = (args.find(a => a.startsWith('--outlet=')) || '').split('=')[1] || null;
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10);

// Outlets the user explicitly called out as high-value targets. Any outlet with
// a dedicated (non-noScoreExtractor) OUTLET_EXTRACTORS entry is also eligible,
// so this list is advisory for counting/reporting only.
const CALLED_OUT_OUTLETS = new Set([
  'nysr', 'ny-stage-review', 'new-york-stage-review', 'nystagereview',
  'timeout', 'time-out', 'timeout-london', 'timeoutny',
  'ew', 'entertainment-weekly',
  'nypost', 'ny-post', 'new-york-post',
  'theatre-weekly',
  'radio-times', 'radiotimes',
  'all-that-dazzles', 'all-that-dazzles-uk',
  'lbo', 'london-box-office',
  'broadwayworld',
]);

function outletHasReliableExtractor(outletId) {
  const extractor = OUTLET_EXTRACTORS[outletId];
  return !!(extractor && extractor.name !== 'noScoreExtractor');
}

function isLowConfidenceScore(data) {
  // Only supersede when: (a) score is entirely missing, or (b) score came from
  // an aggregator thumb/card. Legacy files with originalScore set but a null
  // scoreSource are left alone by default — they were often written by older
  // pipelines or human pastes, and flipping them (e.g. "B+" → "B", "3.5/5" →
  // "3/5") is more likely a format regression than a genuine correction.
  if (!data.originalScore) return true;
  const src = data.scoreSource;
  if (src && AGGREGATOR_SCORE_SOURCES.has(src)) return true;
  return false;
}

function loadArchiveHtml(archivePath) {
  if (!archivePath) return '';
  // archivePath in review files is repo-relative; resolve against repo root.
  const abs = path.resolve(__dirname, '..', archivePath);
  try {
    if (fs.existsSync(abs)) {
      return fs.readFileSync(abs, 'utf8');
    }
  } catch {}
  return '';
}

function shouldSkipPatch(data) {
  // Never touch human-overridden files or locked scores.
  if (data.humanReviewScore != null) return 'human-override';
  if (data.originalScoreCleared === true) return 'score-cleared-by-p0-audit';
  if (data.wrongProduction === true) return 'wrongProduction';
  if (data.wrongShow === true) return 'wrongShow';
  if (data.isPreviewPlaceholder === true) return 'preview-placeholder';
  if (data.rejectionReason) return 'rejected';
  // Respect per-file protectedFields that already lock originalScore.
  if (Array.isArray(data.protectedFields) && data.protectedFields.includes('originalScore')) {
    return 'protected-originalScore';
  }
  return null;
}

const patches = [];
const skipped = { noExtractor: 0, scoreOk: 0, noFullText: 0, noResult: 0, guarded: 0, sameScore: 0 };
let examined = 0;

const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(entry => {
  const fp = path.join(REVIEW_TEXTS_DIR, entry);
  try {
    if (fs.lstatSync(fp).isSymbolicLink()) return false;
    return fs.statSync(fp).isDirectory();
  } catch {
    return false;
  }
});

outer: for (const showId of showDirs) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    const filePath = path.join(dir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }

    const outletId = (data.outletId || '').toLowerCase();
    if (!outletId) continue;
    if (OUTLET_FILTER && outletId !== OUTLET_FILTER) continue;

    if (!outletHasReliableExtractor(outletId)) {
      skipped.noExtractor++;
      continue;
    }

    if (!isLowConfidenceScore(data)) {
      skipped.scoreOk++;
      continue;
    }

    // Require complete fullText — stubs and truncated excerpts are not
    // authoritative enough to supersede an aggregator score.
    if (data.contentTier !== 'complete' || !data.fullText || data.fullText.length < 500) {
      skipped.noFullText++;
      continue;
    }

    const guard = shouldSkipPatch(data);
    if (guard) {
      skipped.guarded++;
      continue;
    }

    examined++;

    const archiveHtml = loadArchiveHtml(data.archivePath);
    const result = extractScore(archiveHtml || '', data.fullText, outletId);

    if (!result || result.normalizedScore == null) {
      skipped.noResult++;
      continue;
    }

    // Don't patch when the extractor returns the same score we already have.
    if (data.originalScore && String(data.originalScore) === String(result.originalScore)) {
      skipped.sameScore++;
      continue;
    }

    patches.push({
      showId,
      file,
      filePath,
      outletId,
      prevScore: data.originalScore || null,
      prevSource: data.scoreSource || null,
      newScore: result.originalScore,
      normalizedScore: result.normalizedScore,
      newSource: result.source,
      hadArchive: !!archiveHtml,
      calledOut: CALLED_OUT_OUTLETS.has(outletId),
    });

    if (LIMIT && patches.length >= LIMIT) break outer;
  }
}

// Report
console.log('='.repeat(80));
console.log(`Backfill extractor rescore — ${WRITE ? 'LIVE WRITE' : 'DRY RUN'}`);
console.log('='.repeat(80));
console.log(`Examined (candidate): ${examined}`);
console.log(`Patches proposed:     ${patches.length}`);
console.log(`Skipped (no-extractor):  ${skipped.noExtractor}`);
console.log(`Skipped (score-ok):      ${skipped.scoreOk}`);
console.log(`Skipped (no-fullText):   ${skipped.noFullText}`);
console.log(`Skipped (guarded):       ${skipped.guarded}`);
console.log(`Skipped (no-result):     ${skipped.noResult}`);
console.log(`Skipped (same-score):    ${skipped.sameScore}`);
console.log('');

const byOutlet = {};
for (const p of patches) {
  byOutlet[p.outletId] = (byOutlet[p.outletId] || 0) + 1;
}
console.log('By outlet:');
for (const [outlet, count] of Object.entries(byOutlet).sort((a, b) => b[1] - a[1])) {
  const calledOut = CALLED_OUT_OUTLETS.has(outlet) ? ' [CALLED-OUT]' : '';
  console.log(`  ${outlet.padEnd(28)} ${count}${calledOut}`);
}
console.log('');

if (patches.length === 0) {
  console.log('No patches to apply.');
  process.exit(0);
}

console.log('Sample patches (first 20):');
for (const p of patches.slice(0, 20)) {
  const prev = p.prevScore ? `${p.prevScore} [${p.prevSource || 'n/a'}]` : 'null';
  console.log(`  ${p.showId}/${p.file}`);
  console.log(`    ${p.outletId}: ${prev}  →  ${p.newScore} (${p.normalizedScore}/100) [${p.newSource}] ${p.hadArchive ? '(archive)' : '(fullText-only)'}`);
}

if (!WRITE) {
  console.log('');
  console.log('Dry-run complete. Re-run with --write to apply patches.');
  process.exit(0);
}

// Apply writes
let written = 0;
for (const p of patches) {
  try {
    const data = JSON.parse(fs.readFileSync(p.filePath, 'utf8'));
    const guard = shouldSkipPatch(data);
    if (guard) continue; // re-check under race
    data.originalScore = p.newScore;
    data.originalScoreNormalized = p.normalizedScore;
    data.scoreSource = p.newSource;
    data.scoreSourceBackfilledAt = new Date().toISOString();
    data.scoreSourceBackfilledBy = 'backfill-extractor-rescore';
    // Persist starRating for fractional star formats so display layers can
    // render the badge without re-parsing originalScore.
    if (typeof p.newScore === 'string') {
      const starMatch = p.newScore.match(/^(\d)\/(\d)(?:\s*stars?)?$/i);
      if (starMatch) {
        data.starRating = `${starMatch[1]}/${starMatch[2]}`;
      }
    }
    delete data.scoreExtractionPending;
    fs.writeFileSync(p.filePath, JSON.stringify(data, null, 2) + '\n');
    written++;
  } catch (e) {
    console.error(`ERROR writing ${p.filePath}: ${e.message}`);
  }
}

console.log('');
console.log(`Wrote ${written} files.`);
