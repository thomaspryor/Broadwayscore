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

const { isIncludableForRebuild, getCriticRegistry } = require('./lib/review-guards');
const { isScoreable } = require('./lib/is-scoreable');
const { classifyRebuildExclusion, classifyLlmExclusion } = require('./lib/llm-scoring-parity');

const REVIEWS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_JSON = path.join(__dirname, '..', 'data', 'shows.json');
const OUT = path.join(__dirname, '..', 'data', 'audit', 'llm-scoring-parity-baseline.json');

const showsRaw = JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8'));
const showsList = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows || [];
const showsById = Object.fromEntries(showsList.map((s) => [s.id, s]));

const SAMPLES_PER_BUCKET = 10;


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

    const rebuildIncludes = isIncludableForRebuild(data, show, filePath);
    const llmIncludes = isScoreable(data, show, filePath);

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
