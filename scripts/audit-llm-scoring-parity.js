#!/usr/bin/env node
/**
 * audit-llm-scoring-parity.js
 *
 * Diffs the two includability predicates that gate review files:
 *   rebuild-side: scripts/lib/review-guards.js#isIncludableForRebuild
 *   llm-side:     scripts/lib/is-scoreable.js#isScoreable
 *
 * For each review file in data/review-texts/, runs both predicates and
 * classifies disagreements into divergence buckets. Each bucket records
 * which flag fired on the rejecting side so the operator can decide
 * whether the divergence is a wasted credit (LLM scores files rebuild
 * excludes) or an orphan-unscored bug (rebuild includes files LLM skips).
 *
 * Output: data/audit/llm-scoring-parity-baseline.json
 *   { generatedAt, scanned, agree, llmPermissiveCount, llmRestrictiveCount,
 *     buckets: { <name>: { count, samples: [{showId, file, ...}] } } }
 *
 * Usage: node scripts/audit-llm-scoring-parity.js
 */

const fs = require('fs');
const path = require('path');

const {
  isIncludableForRebuild,
  isLikelyStaleRoundupFlag,
  isLikelyStaleWrongShow,
  wrongShowCleared,
  isLikelyStaleSuspectedMisattribution,
  getCriticRegistry,
} = require('./lib/review-guards');
const { isScoreable } = require('./lib/is-scoreable');
const { hasExcerpt } = require('./lib/excerpt-fields');

const REVIEWS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_JSON = path.join(__dirname, '..', 'data', 'shows.json');
const OUT = path.join(__dirname, '..', 'data', 'audit', 'llm-scoring-parity-baseline.json');

const showsRaw = JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8'));
const showsList = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows || [];
const showsById = Object.fromEntries(showsList.map((s) => [s.id, s]));

const SAMPLES_PER_BUCKET = 10;

const wpClearedFlags = (data) =>
  data.wrongProductionManualClear === true ||
  data.wrongProductionOverride === true ||
  data.humanReviewedWrongProduction === false;

/**
 * Returns the first firing exclusion reason on the rebuild side, or '' if
 * the file is included. Mirrors isIncludableForRebuild's check order.
 */
function classifyRebuildExclusion(data, show) {
  if (!data) return 'noData';

  if (data.wrongProduction === true && !wpClearedFlags(data)) return 'wrongProduction';
  if (data.wrongShow === true && !wrongShowCleared(data) && !isLikelyStaleWrongShow(data, show)) return 'wrongShow';
  if (data.wrongAttribution === true) return 'wrongAttribution';
  if (data.duplicateOf) return 'duplicateOf';
  if (data.isRoundupArticle === true && !isLikelyStaleRoundupFlag(data)) return 'isRoundupArticle';
  if (
    data.isNonReview === true ||
    data.isNotReview === true ||
    data.nonReviewFlag === true ||
    data.nonReviewContent === true
  ) {
    return 'nonReview';
  }
  if (data.fabricatedEntry === true) return 'fabricatedEntry';
  if (data.isSyndicatedDuplicate === true) return 'isSyndicatedDuplicate';
  if (data.crossOutletDuplicate === true) return 'crossOutletDuplicate';
  if (data.suspectedMisattribution === true) return 'suspectedMisattribution_noStaleOverride';
  if (
    data.contentVerification?.wrongArticle === true &&
    data.contentVerification?.confidence === 'high'
  ) {
    return 'contentVerificationWrongHigh';
  }
  if (data.rejectionReason) return 'rejectionReason';
  if (Array.isArray(data.rejectedBy) && data.rejectedBy.length >= 2) return 'rejectedBy2plus';
  if (data.rejectedAt && typeof data.rejectedAt === 'string') {
    const reFetched =
      data.textFetchedAt &&
      typeof data.textFetchedAt === 'string' &&
      data.textFetchedAt > data.rejectedAt;
    if (!reFetched && !wpClearedFlags(data)) return 'rejectedAt';
  }
  if (data.incompleteReason === 'wrong_content') {
    const wpBlocking = data.wrongProduction === true && !wpClearedFlags(data);
    if (data.wrongShow || wpBlocking) return 'incompleteReason_wrong_content';
    const hasText = !!(data.fullText && data.fullText.trim().length >= 200);
    const hasSignal = !!(data.aggregatorStars != null || data.originalScore != null || data.llmScore);
    if (!hasText && !hasSignal) return 'incompleteReason_wrong_content';
  }
  if (data.contentTier === 'invalid' && !wpClearedFlags(data)) return 'contentTier_invalid';

  if (data.fullTextWrongAuthor === true) {
    const hasExc = !!(
      data.dtliExcerpt ||
      data.bwwExcerpt ||
      data.showScoreExcerpt ||
      data.nycTheatreExcerpt ||
      data.lboRoundupExcerpt ||
      data.stagedoorExcerpt
    );
    if (!hasExc) return 'fullTextWrongAuthor_noExcerpt';
    return ''; // fullTextWrongAuthor with excerpt → included
  }

  const hasText = !!(data.fullText && data.fullText.trim());
  const hasAgg = !!(data.aggregatorStars || data.originalScore != null || data.llmScore);
  if (!hasText && !hasAgg) return 'finalContentGate';

  return '';
}

/**
 * First firing LLM-side exclusion reason, or '' if scoreable.
 * Post-2026-04-29 refactor: LLM delegates to rebuild and layers two extras.
 * Mirrors scripts/lib/is-scoreable.js / scripts/llm-scoring/is-scoreable.ts.
 */
function classifyLlmExclusion(data, show /* unused criticRegistry now */) {
  const rebuildReason = classifyRebuildExclusion(data, show);
  if (rebuildReason) return rebuildReason;
  if (data.incompleteReason === 'scraper_garbage') return 'scraper_garbage';
  if (data.showNotMentioned && !hasExcerpt(data)) return 'showNotMentioned_noExcerpt';
  return '';
}

const buckets = {};
function recordBucket(side, reason, info) {
  const key = `${side}::${reason || 'unknown'}`;
  if (!buckets[key]) buckets[key] = { count: 0, samples: [] };
  buckets[key].count++;
  if (buckets[key].samples.length < SAMPLES_PER_BUCKET) {
    buckets[key].samples.push(info);
  }
}

let scanned = 0;
let agree = 0;
let llmPermissiveCount = 0; // rebuild EXCLUDES, llm SCORES → wasted credit
let llmRestrictiveCount = 0; // rebuild INCLUDES, llm SKIPS → orphan unscored
let groundTruthMismatches = 0;

const criticRegistry = getCriticRegistry();

const showDirs = fs
  .readdirSync(REVIEWS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'));

for (const dirent of showDirs) {
  const showId = dirent.name;
  const dirPath = path.join(REVIEWS_DIR, showId);
  const show = showsById[showId];
  let files;
  try {
    files = fs.readdirSync(dirPath);
  } catch {
    continue;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dirPath, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    scanned++;

    const rebuildIncludes = isIncludableForRebuild(data, show);
    const llmIncludes = isScoreable(data, show);

    if (rebuildIncludes === llmIncludes) {
      agree++;
      continue;
    }

    const rebuildReason = classifyRebuildExclusion(data, show);
    const llmReason = classifyLlmExclusion(data, show);

    // Self-check: classifier should agree with the actual predicate's verdict
    const classifierRebuildIncludes = rebuildReason === '';
    const classifierLlmIncludes = llmReason === '';
    if (classifierRebuildIncludes !== rebuildIncludes || classifierLlmIncludes !== llmIncludes) {
      groundTruthMismatches++;
    }

    const info = {
      showId,
      file,
      criticName: data.criticName,
      outletId: data.outletId,
      url: data.reviewUrl || data.url,
      publishDate: data.publishDate,
      rebuildReason: rebuildReason || '(included)',
      llmReason: llmReason || '(scoreable)',
      flags: {
        wrongProduction: data.wrongProduction,
        wrongProductionManualClear: data.wrongProductionManualClear,
        wrongProductionOverride: data.wrongProductionOverride,
        humanReviewedWrongProduction: data.humanReviewedWrongProduction,
        wrongShow: data.wrongShow,
        wrongAttribution: data.wrongAttribution,
        contentTier: data.contentTier,
        isRoundupArticle: data.isRoundupArticle,
        isNonReview: data.isNonReview,
        isNotReview: data.isNotReview,
        nonReviewFlag: data.nonReviewFlag,
        nonReviewContent: data.nonReviewContent,
        fabricatedEntry: data.fabricatedEntry,
        isSyndicatedDuplicate: data.isSyndicatedDuplicate,
        crossOutletDuplicate: data.crossOutletDuplicate,
        suspectedMisattribution: data.suspectedMisattribution,
        contentVerificationWrong: data.contentVerification?.wrongArticle,
        contentVerificationConfidence: data.contentVerification?.confidence,
        rejectionReason: data.rejectionReason,
        rejectedByLength: Array.isArray(data.rejectedBy) ? data.rejectedBy.length : 0,
        rejectedAt: data.rejectedAt,
        textFetchedAt: data.textFetchedAt,
        incompleteReason: data.incompleteReason,
        fullTextWrongAuthor: data.fullTextWrongAuthor,
        showNotMentioned: data.showNotMentioned,
        fullTextLen: data.fullText ? data.fullText.length : 0,
        hasAggregatorSignal: !!(data.aggregatorStars || data.originalScore != null || data.llmScore),
      },
    };

    if (llmIncludes && !rebuildIncludes) {
      llmPermissiveCount++;
      recordBucket('LLM_PERMISSIVE', rebuildReason, info);
    } else {
      llmRestrictiveCount++;
      recordBucket('LLM_RESTRICTIVE', llmReason, info);
    }
  }
}

const sortedBuckets = Object.fromEntries(
  Object.entries(buckets).sort(([, a], [, b]) => b.count - a.count)
);

const out = {
  generatedAt: new Date().toISOString(),
  scanned,
  agree,
  llmPermissiveCount,
  llmRestrictiveCount,
  groundTruthMismatches,
  buckets: sortedBuckets,
  semantics: {
    LLM_PERMISSIVE: 'rebuild EXCLUDES, llm SCORES — wasted credit; LLM rescores files rebuild will not include',
    LLM_RESTRICTIVE: 'rebuild INCLUDES, llm SKIPS — orphan-unscored class (Lost Boys 2026-04-26 #8)',
    groundTruthMismatches: 'Files where the inline classifier disagreed with the actual predicate. Should be 0.',
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

console.log(
  `\nScanned ${scanned}, agree ${agree}, LLM-permissive ${llmPermissiveCount}, LLM-restrictive ${llmRestrictiveCount}`
);
if (groundTruthMismatches > 0) {
  console.log(`⚠️  ${groundTruthMismatches} ground-truth mismatches — classifier drifts from actual predicate`);
}
console.log('\nBuckets (sorted by count):');
for (const [key, b] of Object.entries(sortedBuckets)) {
  console.log(`  ${key}: ${b.count}`);
}
console.log(`\nWrote ${OUT}`);
