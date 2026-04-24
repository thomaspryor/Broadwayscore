#!/usr/bin/env node
/**
 * ingest-manual-review.js — Paste review text + explicit score directly
 *
 * "Break glass" fallback for opening night corrections when automation
 * fails: paste the full review text and/or an explicit score, and the
 * system creates a properly formatted review file that survives rebuild.
 *
 * Usage:
 *   node scripts/ingest-manual-review.js \
 *     --show=becky-shaw-2026 \
 *     --outlet=nytimes \
 *     --critic="Maya Phillips" \
 *     --url="https://nytimes.com/2026/04/06/theater/becky-shaw-review.html" \
 *     --score=72 \
 *     --text-file=review.txt
 *
 *   # Or with inline text (short reviews):
 *   node scripts/ingest-manual-review.js \
 *     --show=becky-shaw-2026 \
 *     --outlet=variety \
 *     --critic="Frank Rizzo" \
 *     --score=85 \
 *     --text="A triumphant revival that breathes new life into..."
 *
 *   # Score-only (no text):
 *   node scripts/ingest-manual-review.js \
 *     --show=becky-shaw-2026 \
 *     --outlet=nypost \
 *     --critic="Johnny Oleksinski" \
 *     --url="https://nypost.com/..." \
 *     --score=40
 *
 *   # Text-only (no score — let LLM score it):
 *   node scripts/ingest-manual-review.js \
 *     --show=becky-shaw-2026 \
 *     --outlet=vulture \
 *     --critic="Sara Holdren" \
 *     --text-file=vulture-review.txt
 *
 * Options:
 *   --show=ID          Show ID (required)
 *   --outlet=ID        Outlet ID or name (required) — e.g., "nytimes", "The New York Times"
 *   --critic=NAME      Critic name (required)
 *   --url=URL          Review URL (optional but recommended)
 *   --score=N          Explicit score 1-100 (optional — saved as humanReviewScore)
 *   --text=STRING      Inline review text (optional)
 *   --text-file=PATH   Path to file containing review text (optional)
 *   --stars=N/M        Star rating, e.g., "3/5" or "4/4" (optional — converted to 1-100 + saved as originalScore)
 *   --publish-date=D   Publish date, e.g., "2026-04-06" (optional)
 *   --dry-run          Show what would happen without writing
 *   --no-rebuild       Skip triggering rebuild/deploy after
 */

const fs = require('fs');
const path = require('path');

const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { resolveCanonicalOutletId } = require('./lib/outlet-canonicalize');

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const showId = getArg('show');
const outletArg = getArg('outlet');
const criticName = getArg('critic');
const url = getArg('url');
const scoreArg = getArg('score');
const starsArg = getArg('stars');
const inlineText = getArg('text');
const textFile = getArg('text-file');
const publishDate = getArg('publish-date');
const dryRun = hasFlag('dry-run');
const noRebuild = hasFlag('no-rebuild');

// Validate required args
if (!showId || !outletArg || !criticName) {
  console.error('Usage: node scripts/ingest-manual-review.js --show=ID --outlet=ID --critic=NAME [options]');
  console.error('');
  console.error('Required:');
  console.error('  --show=ID          Show ID (e.g., becky-shaw-2026)');
  console.error('  --outlet=ID        Outlet ID or name (e.g., nytimes, "The New York Times")');
  console.error('  --critic=NAME      Critic name (e.g., "Maya Phillips")');
  console.error('');
  console.error('Optional:');
  console.error('  --url=URL          Review URL');
  console.error('  --score=N          Explicit score 1-100 (saved as humanReviewScore — survives rebuild)');
  console.error('  --stars=N/M        Star rating (e.g., "3/5" → converted to score)');
  console.error('  --text=STRING      Inline review text');
  console.error('  --text-file=PATH   File containing review text');
  console.error('  --publish-date=D   Publish date (e.g., 2026-04-06)');
  console.error('  --dry-run          Preview without writing');
  console.error('  --no-rebuild       Skip rebuild/deploy trigger');
  process.exit(1);
}

// Verify show exists
const showsData = require('../data/shows.json');
const show = showsData.shows.find(s => s.id === showId);
if (!show) {
  console.error(`Show not found: ${showId}`);
  console.error('Hint: check data/shows.json for the correct show ID');
  process.exit(1);
}

// Resolve outlet — cross-checks operator input against URL domain via outlet-registry.
// Prevents class-C domain-outlet drift (e.g., 2026-04-23 Rocky Horror ingest wrote
// davidcote-substack for a davidcote1.substack.com URL that maps canonically to cote-notices).
const resolved = resolveCanonicalOutletId({ outletArg, url });
if (resolved.warning) {
  console.warn(`⚠️  ${resolved.warning}`);
}
const outletId = resolved.outletId;
const outletName = resolved.displayName;

// Parse score
let humanScore = null;
if (scoreArg) {
  humanScore = parseInt(scoreArg, 10);
  if (isNaN(humanScore) || humanScore < 1 || humanScore > 100) {
    console.error(`Invalid score: ${scoreArg} (must be 1-100)`);
    process.exit(1);
  }
}

// Parse star rating → score + originalScore
let originalScore = null;
let originalScoreSource = null;
if (starsArg) {
  const match = starsArg.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+)$/);
  if (!match) {
    console.error(`Invalid stars format: ${starsArg} (expected N/M, e.g., "3/5")`);
    process.exit(1);
  }
  const [, num, denom] = match;
  const normalized = Math.round((parseFloat(num) / parseFloat(denom)) * 100);
  originalScore = starsArg;
  originalScoreSource = 'manual-stars';
  // If no explicit --score given, derive from stars
  if (!humanScore) {
    humanScore = normalized;
  }
}

// Get review text
let fullText = null;
if (textFile) {
  if (!fs.existsSync(textFile)) {
    console.error(`Text file not found: ${textFile}`);
    process.exit(1);
  }
  fullText = fs.readFileSync(textFile, 'utf8').trim();
} else if (inlineText) {
  fullText = inlineText;
}

// Summary
console.log(`\n╔══════════════════════════════════════════════════╗`);
console.log(`║  Manual Review Ingestion${dryRun ? ' (DRY RUN)' : ''}`);
console.log(`║  Show: ${show.title} (${showId})`);
console.log(`║  Outlet: ${outletName} (${outletId})`);
console.log(`║  Critic: ${criticName}`);
if (url) console.log(`║  URL: ${url}`);
if (humanScore) console.log(`║  Score: ${humanScore} (humanReviewScore — survives rebuild)`);
if (originalScore) console.log(`║  Stars: ${originalScore} → ${humanScore}`);
if (fullText) console.log(`║  Text: ${fullText.length} chars`);
if (publishDate) console.log(`║  Published: ${publishDate}`);
console.log(`╚══════════════════════════════════════════════════╝\n`);

// Build fields
const fields = {};

if (fullText) {
  fields.fullText = fullText;
  fields.textFetchedAt = new Date().toISOString();
  fields.fetchMethod = 'manual-entry';
  // Lock content tier so rebuild doesn't reclassify
  fields.manualContentTier = 'complete';
}

if (humanScore) {
  // humanReviewScore is the ONLY score field rebuild respects
  fields.humanReviewScore = humanScore;
}

// Full protection field set — missing any one means a different guard re-flags the review.
// These survive rebuild scoring, content reclassification, wrong-production flagging,
// wrong-show classification, pre-opening date guards, tour/film-signal guards, and
// cross-market re-routing. The Beaches 2026-04-22 opening silently dropped 4 reviews
// because this block only set 3 of the needed fields.
//
// Why each one:
//   wrongProduction=false + wrongProductionManualClear=true    — bypass year/date-drift flagger
//   wrongShow=false + wrongShowManualClear=true                — bypass cross-show heuristic
//   wrongProductionOverride=true                               — older guard path still reads this
//   wrongArticleManualClear=true                               — bypass "not a review" classifier
//   humanReviewedWrongProduction=false                         — "human verified IS correct production"
//   humanReviewedWrongArticle=false                            — "human verified IS a review"
//   allowEarlyDate=true + allowLateDate=true + allowCrossMarket=true  — bypass temporal/market gates
//   allowTourSignal=true + allowFilmSignal=true                — bypass keyword-based auto-exclusions
//   contentVerification.{wrongProduction,wrongArticle}=false   — nested ensemble-scorer state
fields.wrongProduction = false;
fields.wrongProductionManualClear = true;
fields.wrongProductionOverride = true;
fields.wrongShow = false;
fields.wrongShowManualClear = true;
fields.wrongArticleManualClear = true;
fields.humanReviewedWrongProduction = false;
fields.humanReviewedWrongArticle = false;
fields.allowEarlyDate = true;
fields.allowLateDate = true;
fields.allowCrossMarket = true;
fields.allowTourSignal = true;
fields.allowFilmSignal = true;
fields.contentVerification = {
  wrongProduction: false,
  wrongArticle: false,
};

// Per-file protection lock — unions with global PROTECTED_FIELDS in
// review-write-guard.js so these exact fields can't be silently dropped
// on rebase even if one of them is later removed from the global list.
// See memory/feedback_per_file_protected_fields_lock.md (Beaches 2026-04-22).
fields.protectedFields = [
  'humanReviewScore',
  'manualContentTier',
  'wrongProduction',
  'wrongProductionManualClear',
  'wrongProductionOverride',
  'wrongShow',
  'wrongShowManualClear',
  'wrongArticleManualClear',
  'humanReviewedWrongProduction',
  'humanReviewedWrongArticle',
  'allowEarlyDate',
  'allowLateDate',
  'allowCrossMarket',
  'allowTourSignal',
  'allowFilmSignal',
  'contentVerification',
  'fullText',
  'textFetchedAt',
  'originalScore',
  'originalScoreSource',
  'originalScoreNormalized',
];

if (originalScore) {
  fields.originalScore = originalScore;
  fields.originalScoreSource = originalScoreSource;
  fields.originalScoreNormalized = humanScore;
}

if (publishDate) {
  fields.publishDate = publishDate;
}

// Create the review file
const input = {
  outletId,
  outlet: outletName,
  criticName,
  url: url || '',
  source: 'manual-entry',
  fields,
};

const result = createOrMergeReviewFile(showId, input, { dryRun });

if (result.action === 'new') {
  console.log(`✅ Created: ${result.filepath}`);
} else if (result.action === 'updated') {
  console.log(`✅ Updated: ${result.filepath}`);
} else {
  console.log(`⚠️  Skipped: ${result.reason}`);
  if (!dryRun) process.exit(1);
}

if (dryRun) {
  console.log('\n(Dry run — no files written, no rebuild triggered)');
  process.exit(0);
}

// Trigger rebuild + deploy
if (!noRebuild) {
  console.log('\nTriggering rebuild + scoring + deploy...');
  try {
    const { execSync } = require('child_process');
    execSync(
      `gh workflow run "Rebuild Reviews Data" -f reason="Manual review: ${outletId} for ${showId}"`,
      { stdio: 'inherit' }
    );
    console.log('✅ Rebuild triggered. Monitor: gh run list --workflow=rebuild-reviews.yml --limit=3');
  } catch (e) {
    console.error('⚠️  Could not trigger rebuild:', e.message);
    console.error('   Run manually: gh workflow run "Rebuild Reviews Data"');
  }
}

console.log('\nDone.');
if (humanScore) {
  console.log(`\nNote: humanReviewScore=${humanScore} will survive all future rebuilds.`);
  console.log('To change it later, edit the file directly and set a new humanReviewScore value.');
}
if (fullText) {
  console.log(`\nNote: manualContentTier=complete will prevent rebuild from reclassifying this review.`);
  console.log('To unlock, remove the manualContentTier field from the file.');
}
