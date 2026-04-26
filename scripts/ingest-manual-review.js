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
const { buildManualReviewFields, detectIngestCollision } = require('./lib/manual-review-fields');
const {
  recoverFromText,
  recoverFromUrl,
  _hasDedicatedExtractor,
} = require('./lib/recover-manual-review-score');

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
const forceClearStale = hasFlag('force-clear-stale-flag');
const provisional = hasFlag('provisional');
const noAutoExtract = hasFlag('no-auto-extract');

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
  console.error('  --provisional      Mark humanReviewScore as tentative — LLM scoring will override');
  console.error('                     once it runs. Default (no flag) is LOCKED (Helen Shaw behavior).');
  console.error('  --stars=N/M        Star rating (e.g., "3/5" → converted to score)');
  console.error('  --text=STRING      Inline review text');
  console.error('  --text-file=PATH   File containing review text');
  console.error('  --publish-date=D   Publish date (e.g., 2026-04-06)');
  console.error('  --dry-run          Preview without writing');
  console.error('  --no-rebuild       Skip rebuild/deploy trigger');
  console.error('  --force-clear-stale-flag   Ingest even if an existing file has wrongProduction/');
  console.error('                              wrongShow=true or a publishDate >365 days off');
  console.error('  --no-auto-extract  Skip the opportunistic URL fetch + score-extractor recovery.');
  console.error('                     Default: when --score/--stars not set and outlet has a dedicated');
  console.error('                     extractor (nysr, timeout, guardian, ...), fetch the URL and try');
  console.error('                     to recover the published rating from HTML (RHS 2026-04-23 NYSR fix).');
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

// Async tail: opportunistic score recovery + ingest. Wrapped because
// score recovery calls fetchPage (async) and the rest of the script
// can't easily run before it.
(async () => {

// Opportunistic score recovery (RHS 2026-04-23 NYSR fix).
// When operator pasted a review with no explicit --score/--stars, try to
// recover the published rating from text or HTML. Runs ONLY when the
// outlet has a dedicated extractor (nysr, timeout, guardian, UK stars,
// etc.) — never on noScoreExtractor outlets where false positives ruin
// scores. Sync text scan first (free); URL fetch only if text scan misses
// AND a URL was supplied. --no-auto-extract opts out.
if (!originalScore && !noAutoExtract && _hasDedicatedExtractor(outletId)) {
  let recovered = recoverFromText(fullText, outletId);
  if (!recovered && url) {
    console.log(`Outlet "${outletId}" has a dedicated rating extractor — fetching URL to recover stars...`);
    recovered = await recoverFromUrl(url, outletId, { log: (m) => console.log(m) });
  }
  if (recovered && recovered.normalizedScore != null) {
    originalScore = recovered.originalScore;
    originalScoreSource = recovered.source || 'extractor-recovered';
    if (humanScore == null) {
      humanScore = recovered.normalizedScore;
    }
    console.log(`✦ Auto-recovered rating: ${originalScore} → ${recovered.normalizedScore} [${originalScoreSource}]`);
  }
}

// Summary
console.log(`\n╔══════════════════════════════════════════════════╗`);
console.log(`║  Manual Review Ingestion${dryRun ? ' (DRY RUN)' : ''}`);
console.log(`║  Show: ${show.title} (${showId})`);
console.log(`║  Outlet: ${outletName} (${outletId})`);
console.log(`║  Critic: ${criticName}`);
if (url) console.log(`║  URL: ${url}`);
if (humanScore) console.log(`║  Score: ${humanScore} (humanReviewScore — ${provisional ? 'PROVISIONAL, LLM may override' : 'LOCKED, wins over LLM'})`);
if (originalScore) console.log(`║  Stars: ${originalScore} → ${humanScore}`);
if (fullText) console.log(`║  Text: ${fullText.length} chars`);
if (publishDate) console.log(`║  Published: ${publishDate}`);
console.log(`╚══════════════════════════════════════════════════╝\n`);

// Pre-write collision check (postmortem #9). A 2015 Chris Jones Chicago Tribune
// file with wrongProduction:true silently "merged" a 2026 URL during the Beaches
// ingest — the flag was preserved and the new review dropped. Catch the case
// before createOrMergeReviewFile is called and show the operator what's there.
const showDir = path.join(__dirname, '..', 'data', 'review-texts', showId);
const collision = detectIngestCollision({
  showDir,
  outletId,
  criticName,
  url,
  publishDate,
  forceClearStale,
});
if (!collision.ok) {
  console.error(`\n❌ Refusing to ingest — collision with ${collision.file}`);
  console.error(`   reason: ${collision.reason}`);
  console.error(`   detail: ${JSON.stringify(collision.detail, null, 2)}`);
  console.error(`\nEither fix the existing file first (delete / clear the flag / rename)`);
  console.error(`or re-run with --force-clear-stale-flag to proceed anyway.`);
  process.exit(1);
}

// Build fields via the shared library (scripts/lib/manual-review-fields.js).
// See that module for the full rationale on each protection field. Keeping
// the logic there lets tests pin the 8-field invariant (see
// tests/unit/ingest-manual-review-fields.test.mjs) — if a future edit drops
// one, CI catches it before another opening night.
const fields = buildManualReviewFields({
  humanScore,
  provisional,
  fullText,
  originalScore,
  originalScoreSource,
  publishDate,
});

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
  if (provisional) {
    console.log(`\nNote: humanReviewScore=${humanScore} saved with humanReviewScoreProvisional=true.`);
    console.log('LLM ensemble scoring WILL override this once it runs.');
    console.log('To lock the score instead, edit the file and set humanReviewScoreProvisional=false.');
  } else {
    console.log(`\nNote: humanReviewScore=${humanScore} is LOCKED (humanReviewScoreProvisional=false).`);
    console.log('The rebuild resolver returns it at P0 — LLM scores will not override.');
    console.log('To change it later, edit the file directly and set a new humanReviewScore value.');
  }
}
if (fullText) {
  console.log(`\nNote: manualContentTier=complete will prevent rebuild from reclassifying this review.`);
  console.log('To unlock, remove the manualContentTier field from the file.');
}

})().catch((e) => {
  console.error('Ingest failed:', e.stack || e.message);
  process.exit(1);
});
