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

// REVIEW_TEXTS_DIR resolution:
//   1. --review-texts=PATH CLI flag (explicit)
//   2. REVIEW_TEXTS_DIR env var
//   3. default: data/review-texts/ relative to repo
// The private-repo copy at ~/broadway-review-texts/ is the authoritative
// source of truth (CI reads from there). Main-repo data/review-texts/ is a
// gitignored local cache that does NOT propagate to CI. When running this
// backfill locally for a real write, point at the private repo.
const REVIEW_TEXTS_DIR = (() => {
  const flag = (process.argv.find(a => a.startsWith('--review-texts=')) || '').split('=')[1];
  if (flag) return path.resolve(flag);
  if (process.env.REVIEW_TEXTS_DIR) return path.resolve(process.env.REVIEW_TEXTS_DIR);
  return path.join(__dirname, '../data/review-texts');
})();
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

// Extractor sources trusted for fullText-only backfill. These either anchor
// to a unicode glyph, pull from a structured image alt-attribute or CSS
// class count, or parse an unambiguous textual format.
//
// Excluded: 'text-pattern' — too liberal; it false-positives on numeric
// sequences inside image URL paths / date strings (proven on
// arcadia-west-end-2026/standard--nick-curtis.json where "2/5" matched a
// path fragment "/2026/01/23/12/50/Render" in CDN metadata).
//
// NOT listed (intentional): 'lbo-css-stars', 'show-score-stars',
// 'theatre-reviews-star-rating', 'westendtheatre-star-rating',
// 'stagedoor-star-rating', 'thestage-roundup-star-rating' — these are
// AGGREGATOR_SCORE_SOURCES (scripts/lib/review-normalization.js:36). They
// route to aggregatorStars, not originalScore; the backfill predicate's
// aggregator-supersede guard handles them separately.
//
// All entries below verified against actual `source:` emissions in
// scripts/lib/score-extractors.js (ship-check 2026-04-24 P1-3 audit).
// Removed vs prior version: 'timeout-star-widget', 'meta-itemprop',
// 'telegraph-svg' — never emitted by any extractor. Added: 'css-stars'
// (extractNYPostScore — structured DOM element count, safe).
const ANCHORED_EXTRACTOR_SOURCES = new Set([
  // Structured: CSS/DOM counts, JSON-LD, image alt attrs
  'css-stars',              // NYPost rating__star--filled / --half
  'json-ld',                // schema.org review ratings
  'star-class',             // class="N-star" etc
  'fivestar-widget',
  'bww-star-image',
  'theatre-weekly-star-image',
  'afridiziak-star-image',
  'dailymail-rating-img',
  'dailymail-css-stars',
  'stage-star-svg',
  'wos-star-images',
  'telegraph-svg-stars',
  'timeout-svg-stars',
  'radiotimes-page-json',
  'radiotimes-svg-stars',
  'omc-alt-text',
  'omc-star-rating',
  // Unicode glyphs (anchored; NYSR fallback position-gated 2026-04-24)
  'unicode-stars',
  'unicode-stars-fallthrough',
  'numeric-stars',
  'word-stars',
  'atd-emoji-stars',
  // Canonical parsers
  'letter-grade',
  'reviewshub-percentage',
  // Legacy/recovery scripts (legit)
  'guardian-api',           // recover-explicit-ratings.js:389
  'explicit-rating',        // fix-p0-score-corruption.js:104
  'original-star-rating',   // diagnostic-p0-score-audit.js:48
  // Removed 2026-04-25 (ship-check P2 audit): 'guardian-json-ld',
  // 'guardian-svg-stars'. Never emitted — Guardian extractor returns 'json-ld'
  // (P3 path) or falls through; recover-explicit-ratings.js only emits
  // 'guardian-api'. Same class as prior audit's removals
  // (timeout-star-widget, meta-itemprop, telegraph-svg).
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

    // Guard against loose text-pattern matches. fullText-only extraction can
    // match numeric sequences inside CDN URLs / dates (e.g. "2/5" in
    // "/2026/01/23/12/50/Render-Final.jpg"). Restrict to sources that anchor
    // on a unicode glyph, structured alt-text, or a canonical format parser.
    // Text-pattern regex fills are deferred — they need their own extractor
    // hardening (anchor gates) before backfill is safe.
    if (!ANCHORED_EXTRACTOR_SOURCES.has(result.source)) {
      skipped.looseSource = (skipped.looseSource || 0) + 1;
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
console.log(`Skipped (loose-source):  ${skipped.looseSource || 0}  (text-pattern etc — needs extractor anchor fix)`);
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
