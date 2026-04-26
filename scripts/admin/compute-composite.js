#!/usr/bin/env node
/**
 * Predict composite score for a show from current review-text source files,
 * without running rebuild. Useful during opening night to validate manual
 * score additions/overrides before deploying.
 *
 * Usage:
 *   node scripts/admin/compute-composite.js joe-turners-come-and-gone-2026
 *   node scripts/admin/compute-composite.js --show=joe-turners-come-and-gone-2026
 *   node scripts/admin/compute-composite.js --show=oklahoma-2019 --verbose
 *
 * Outputs:
 *   - Predicted composite (tier-weighted average across included reviews)
 *   - Delta vs current deployed compositeScore in reviews.json
 *   - Per-review breakdown (included / excluded)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Walk up from __dirname until we find data/shows.json (handles any worktree depth).
function findRoot() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'data', 'shows.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (fs.existsSync(path.join(process.cwd(), 'data', 'shows.json'))) return process.cwd();
  return path.join(__dirname, '..', '..');
}

const ROOT = findRoot();
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const SHOWS_JSON = path.join(ROOT, 'data', 'shows.json');
const REVIEWS_JSON = path.join(ROOT, 'data', 'reviews.json');
const OUTLET_REGISTRY_JSON = path.join(ROOT, 'data', 'outlet-registry.json');

const { computeCriticScore, TOP_CRITICS } = require('../lib/compute-critic-score');
const { isIncludableForRebuild } = require('../lib/review-guards');

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const showArg = args.find(a => a.startsWith('--show='))?.slice(7)
  || args.find(a => !a.startsWith('--'));

if (!showArg) {
  console.error('Usage: node scripts/admin/compute-composite.js <showId> [--verbose]');
  process.exit(1);
}

const showId = showArg.trim();

// ─── Load data ───────────────────────────────────────────────────────────────

// outletRegistry provides tier data for long-tail outlets not in outlet-tiers.json
const outletRegistry = (() => {
  try { return JSON.parse(fs.readFileSync(OUTLET_REGISTRY_JSON, 'utf8')).outlets || {}; }
  catch { return {}; }
})();

const showsRaw = JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8'));
const shows = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const show = shows.find(s => s.id === showId);
if (!show) {
  console.error(`Show not found: ${showId}`);
  process.exit(1);
}

const showDir = path.join(REVIEW_TEXTS_DIR, showId);
if (!fs.existsSync(showDir)) {
  console.error(`No review-texts directory for: ${showId}`);
  process.exit(1);
}

// Current deployed composite — compute from reviews.json using same scoring logic
// (reviews.json stores per-review records; compositeScore is computed at build time)
let deployedComposite = null;
try {
  const reviewsRaw = JSON.parse(fs.readFileSync(REVIEWS_JSON, 'utf8'));
  const allReviews = reviewsRaw.reviews || (Array.isArray(reviewsRaw) ? reviewsRaw : []);
  const showReviews = allReviews.filter(r => r && r.showId === showId && !r.singleModelEmergency);
  const deployed = computeCriticScore(showReviews, outletRegistry);
  if (deployed) deployedComposite = Math.round(deployed.s);
} catch { /* reviews.json unavailable */ }

// ─── Read and filter review files ────────────────────────────────────────────

const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

const included = [];
const excluded = [];

for (const f of files) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')); }
  catch { excluded.push({ file: f, reason: 'parse error' }); continue; }

  // Must pass rebuild inclusion gate
  if (!isIncludableForRebuild(data, show)) {
    const reason = getExclusionReason(data);
    excluded.push({ file: f, reason, data });
    continue;
  }

  // Single-model emergency reviews are excluded from compositeScore by engine.ts
  if (data.singleModelEmergency === true) {
    excluded.push({ file: f, reason: 'singleModelEmergency', data });
    continue;
  }

  // Must have a score
  if (data.assignedScore == null) {
    excluded.push({ file: f, reason: 'no assignedScore', data });
    continue;
  }

  included.push({
    file: f,
    outletId: data.outletId,
    outlet: data.outlet,
    criticName: data.criticName,
    assignedScore: data.assignedScore,
    contentTier: data.contentTier,
    designation: data.designation,
    publishDate: data.publishDate,
    dtliThumb: data.dtliThumb,
    bwwThumb: data.bwwThumb,
    needsReview: data.needsReview,
  });
}

// ─── Compute predicted composite ─────────────────────────────────────────────

const result = computeCriticScore(included, outletRegistry);

// ─── Output ──────────────────────────────────────────────────────────────────

const T = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

console.log(`\n${T.bold}Composite prediction: ${show.title} (${showId})${T.reset}`);
console.log(`${'─'.repeat(60)}`);

if (!result) {
  console.log(`${T.red}No scored reviews — composite: null${T.reset}`);
} else {
  const predicted = Math.round(result.s);
  let deltaStr = '';
  if (deployedComposite !== null) {
    const delta = predicted - Math.round(deployedComposite);
    const sign = delta > 0 ? '+' : '';
    const color = delta > 0 ? T.green : delta < 0 ? T.red : T.dim;
    deltaStr = `  ${color}(${sign}${delta} vs deployed ${Math.round(deployedComposite)})${T.reset}`;
  }
  console.log(`${T.bold}Predicted composite: ${predicted}${T.reset}${deltaStr}`);
  console.log(`Reviews included:    ${result.rc} (T1: ${result.t1})`);
}

// ─── Included reviews breakdown ───────────────────────────────────────────────

const outletTiers = require(path.join(ROOT, 'src', 'config', 'outlet-tiers.json'));

console.log(`\n${T.cyan}Included (${included.length}):${T.reset}`);
if (included.length === 0) {
  console.log(`  ${T.dim}(none)${T.reset}`);
} else {
  const sorted = [...included].sort((a, b) => b.assignedScore - a.assignedScore);
  for (const r of sorted) {
    const critic = r.criticName || '?';
    const outlet = r.outletId || r.outlet || '?';
    const tier = getTier(r, outletTiers);
    const conf = getConfidenceWeight(r);
    const tierLabel = tier === 1 ? `${T.bold}T1${T.reset}` : tier === 2 ? 'T2' : `${T.dim}T3${T.reset}`;
    const confLabel = conf < 1 ? ` conf=${conf}` : '';
    const desig = r.designation ? ` [${r.designation}]` : '';
    console.log(`  ${String(r.assignedScore).padStart(3)} ${tierLabel}  ${critic} @ ${outlet}${desig}${confLabel}`);
  }
}

// ─── Excluded reviews breakdown ───────────────────────────────────────────────

if (verbose && excluded.length > 0) {
  console.log(`\n${T.dim}Excluded (${excluded.length}):${T.reset}`);
  for (const r of excluded) {
    const critic = r.data?.criticName || r.file;
    const score = r.data?.assignedScore != null ? ` score=${r.data.assignedScore}` : '';
    console.log(`  ${T.dim}${critic}  [${r.reason}]${score}${T.reset}`);
  }
} else if (excluded.length > 0) {
  console.log(`\n${T.dim}Excluded: ${excluded.length} (use --verbose to see details)${T.reset}`);
}

console.log();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getExclusionReason(data) {
  if (data.wrongProduction === true) return 'wrongProduction';
  if (data.wrongShow === true) return 'wrongShow';
  if (data.wrongAttribution === true) return 'wrongAttribution';
  if (data.duplicateOf) return `duplicateOf:${data.duplicateOf}`;
  if (data.isRoundupArticle === true) return 'isRoundupArticle';
  if (data.isNonReview || data.nonReviewFlag || data.nonReviewContent) return 'isNonReview';
  if (data.fabricatedEntry === true) return 'fabricatedEntry';
  if (data.isSyndicatedDuplicate === true) return 'isSyndicatedDuplicate';
  if (data.crossOutletDuplicate === true) return 'crossOutletDuplicate';
  if (data.rejectionReason) return `rejected:${data.rejectionReason}`;
  if (data.rejectedAt) return 'rejectedAt';
  if (data.incompleteReason === 'wrong_content') return 'wrong_content';
  return 'excluded';
}

function getTier(review, tiers) {
  const isTop = !!(review.criticName && TOP_CRITICS.has(review.criticName));
  if (isTop) return 1;
  const id = (review.outletId || '').toLowerCase().trim();
  return tiers[id]?.tier || outletRegistry[id]?.tier || 3;
}

function getConfidenceWeight(review) {
  const thumbReflected = !!(review.dtliThumb || review.bwwThumb) && !review.needsReview;
  if (review.contentTier === 'excerpt' || review.contentTier === 'stub') {
    return thumbReflected ? 0.75 : 0.5;
  }
  if (review.contentTier === 'truncated') return 0.85;
  return 1.0;
}
