#!/usr/bin/env node
/**
 * run-cohort-recovery.js — S3 Phase B cohort recovery wrapper.
 *
 * Targets a specific list of review files (cohort) and runs them through the
 * existing collect-review-texts.js multi-tier fetch cascade. Unlike a vanilla
 * `--retry-failed` invocation, this wrapper explicitly feeds each cohort entry
 * (showId + filename) into the script via REVIEW_FILTER + SHOW_FILTER env vars,
 * which short-circuits the script's own queue/permanently-failed gates and
 * forces re-fetch even when the file already has aggregator-excerpt fullText.
 *
 * Cohort source: data/audit/recovery-targets-2026-04-26.json (1009 files,
 * outlier_safe partition from wrong-production parity audit). These are reviews
 * with empty fullText but valid llmScore — text was stripped during a content-
 * quality migration. Recovery + re-ensemble-score will freshen composite scores.
 *
 * Usage:
 *   node scripts/run-cohort-recovery.js --limit=20 --dry-run    # Preview 20 targets
 *   node scripts/run-cohort-recovery.js --limit=20              # Real canary
 *   node scripts/run-cohort-recovery.js                          # Full bulk
 *   node scripts/run-cohort-recovery.js --resume                 # Continue last run
 *   node scripts/run-cohort-recovery.js --cohort=path.json --max-cost=25
 *
 * CLI flags:
 *   --cohort=<path>         Input cohort JSON (default: data/audit/recovery-targets-2026-04-26.json)
 *   --batch-size=<N>        Files per child process (default: 50)
 *   --limit=<N>             Cap to N files (default: 0 = all)
 *   --dry-run               Print plan, do not fetch
 *   --resume                Pick up from data/audit/recovery-progress.json
 *   --max-cost=<dollars>    Hard abort if estimated spend exceeds (default: 50)
 *   --diverse-canary        Hand-pick diverse 20 (only when --limit=20)
 *   --skip-preflight        Skip the budget pre-flight (NEVER use in production)
 *
 * Exit codes:
 *   0 — completed (whether 0% or 100% success)
 *   1 — pre-flight or budget abort
 *   2 — invariant / argument error
 *   3 — interrupted (SIGINT/SIGTERM); progress saved
 *
 * Output:
 *   data/audit/recovery-progress.json — resumable in-flight state
 *   data/audit/recovery-results-<UTC-timestamp>.json — final report
 *
 * Side effects on each successful recovery:
 *   - data/review-texts/{showId}/{file}.json gets fullText written by
 *     collect-review-texts.js
 *   - This wrapper additionally stamps:
 *       recoveredAt: ISO,
 *       recoveredVia: <tier method>,
 *       recoveredFromCohort: 'outlier_safe-2026-04-26'
 *
 * Cost estimates (rough):
 *   Archive.org / Wayback: free
 *   Playwright: free (compute time only)
 *   AMP: free
 *   ScrapingBee: ~$0.001/credit, 5-25 credits/page
 *   Bright Data: ~$0.0035/page (Web Unlocker)
 *   Browserbase: ~$0.10/browser hour (~$0.005-$0.015 per fetch)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const AUDIT_DIR = path.join(REPO_ROOT, 'data', 'audit');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data', 'review-texts');
const PROGRESS_PATH = path.join(AUDIT_DIR, 'recovery-progress.json');
const DEFAULT_COHORT = path.join(AUDIT_DIR, 'recovery-targets-2026-04-26.json');
const COHORT_TAG = 'outlier_safe-2026-04-26';

// Per-tier cost estimates (USD per fetch, conservative upper-bound)
const TIER_COST_USD = {
  'archive': 0,
  'archive-first': 0,
  'archive-cdx': 0,
  'archive-cdx-final': 0,
  'archive-today': 0,
  'archive-final': 0,
  'archive-404-recovery': 0,
  'wayback': 0,
  'amp': 0,
  'amp-variant': 0,
  'playwright': 0,
  'direct-cookies': 0,
  'guardian-api': 0,
  'browserbase': 0.015,
  'scrapingbee': 0.005,
  'brightdata': 0.0035,
  'unknown': 0.005,
};

// ----------------------------------------------------------------------------
// Argument parsing
// ----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    cohort: DEFAULT_COHORT,
    'batch-size': 50,
    limit: 0,
    'dry-run': false,
    resume: false,
    'max-cost': 50,
    'diverse-canary': false,
    'skip-preflight': false,
  };
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.+))?$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (value === undefined) {
      args[key] = true;
    } else if (key === 'batch-size' || key === 'limit' || key === 'max-cost') {
      args[key] = parseFloat(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

// ----------------------------------------------------------------------------
// Cohort loading + dedup
// ----------------------------------------------------------------------------

function loadCohort(cohortPath) {
  if (!fs.existsSync(cohortPath)) {
    console.error(`ERROR: Cohort file not found: ${cohortPath}`);
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(cohortPath, 'utf8'));
  const targets = raw.targets || raw;
  if (!Array.isArray(targets)) {
    console.error(`ERROR: Cohort file has no .targets array`);
    process.exit(2);
  }
  return targets;
}

/**
 * For each target: read on-disk review file. If fullText.length > 1000, mark
 * "already-recovered". Returns { remaining, alreadyRecovered, missing }.
 */
function filterAlreadyRecovered(targets) {
  const remaining = [];
  const alreadyRecovered = [];
  const missing = [];
  for (const t of targets) {
    const filePath = path.join(REVIEW_TEXTS_DIR, t.showId, t.file);
    if (!fs.existsSync(filePath)) {
      missing.push(t);
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const len = (data.fullText || '').length;
      if (len > 1000) {
        alreadyRecovered.push({ ...t, currentChars: len });
      } else {
        remaining.push(t);
      }
    } catch (e) {
      // Unparseable — treat as remaining; collect-review-texts will deal with it
      remaining.push(t);
    }
  }
  return { remaining, alreadyRecovered, missing };
}

/**
 * Pick a diverse subset of N targets covering different outlet/age strata.
 * Used for the canary so we don't accidentally test 20 of the same outlet.
 */
function pickDiverseSubset(targets, n) {
  const t1Outlets = new Set(['nyt', 'about-entertainment', 'variety', 'hollywoodreporter', 'gotham-playgoer', 'nytimes']);
  const paywalled = new Set(['wsj', 'washington-post', 'wapo', 'bloomberg', 'newyorker']);
  const urlRotProne = new Set(['vulture', 'theatermania', 'about-entertainment', 'huffpost', 'newsday']);

  const buckets = {
    workingT1: [],
    paywalled: [],
    urlRot: [],
    pre2011: [],
    other: [],
  };
  for (const t of targets) {
    const outletId = (t.outletId || '').toLowerCase();
    const yearMatch = t.showId.match(/-(\d{4})$/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : 9999;
    if (t1Outlets.has(outletId)) buckets.workingT1.push(t);
    else if (paywalled.has(outletId)) buckets.paywalled.push(t);
    else if (urlRotProne.has(outletId)) buckets.urlRot.push(t);
    else if (year < 2011) buckets.pre2011.push(t);
    else buckets.other.push(t);
  }

  // Take 4 from each bucket, fill remainder with `other`.
  const picked = [];
  const seen = new Set();
  function take(bucket, count) {
    for (const t of bucket) {
      if (picked.length >= n) return;
      const key = `${t.showId}/${t.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(t);
      count--;
      if (count <= 0) return;
    }
  }
  take(buckets.workingT1, 4);
  take(buckets.paywalled, 4);
  take(buckets.urlRot, 4);
  take(buckets.pre2011, 4);
  take(buckets.other, 4);
  // Fill remainder
  const remaining = [...buckets.workingT1, ...buckets.paywalled, ...buckets.urlRot, ...buckets.pre2011, ...buckets.other];
  for (const t of remaining) {
    if (picked.length >= n) break;
    const key = `${t.showId}/${t.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(t);
  }
  return picked;
}

// ----------------------------------------------------------------------------
// Pre-flight + marker shells
// ----------------------------------------------------------------------------

function runChild(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: opts.stdio || 'inherit', cwd: REPO_ROOT, env: { ...process.env, ...(opts.env || {}) } });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}

async function preflightBudget({ minCredits }) {
  console.log(`\n=== Pre-flight: budget check (min-credits=${minCredits}) ===`);
  const code = await runChild('node', [
    path.join(__dirname, 'preflight-recovery-budget.js'),
    `--min-credits-remaining=${minCredits}`,
    '--threshold-bd=enabled',
  ]);
  if (code !== 0) {
    console.error(`\n❌ BUDGET PRE-FLIGHT FAILED (exit ${code}). Aborting.`);
    process.exit(1);
  }
  console.log(`✓ Pre-flight passed`);
}

async function setRecoveryMarker(hours, reason) {
  console.log(`\n=== Setting recovery marker (${hours}h) ===`);
  const code = await runChild('node', [
    path.join(__dirname, 'recovery-marker.js'),
    'set',
    `--hours=${hours}`,
    `--reason=${reason}`,
  ]);
  if (code !== 0) {
    console.error(`⚠ recovery-marker set failed (exit ${code}); continuing anyway`);
  }
}

async function clearRecoveryMarker() {
  console.log(`\n=== Clearing recovery marker ===`);
  await runChild('node', [path.join(__dirname, 'recovery-marker.js'), 'clear']);
}

// ----------------------------------------------------------------------------
// Per-batch state capture + post-process
// ----------------------------------------------------------------------------

function readReviewSnapshot(showId, file) {
  const filePath = path.join(REVIEW_TEXTS_DIR, showId, file);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      filePath,
      fullTextLength: (data.fullText || '').length,
      fetchMethod: data.fetchMethod || null,
      sourceMethod: data.sourceMethod || null,
      collectedVia: data.collectedVia || null,
      textFetchedAt: data.textFetchedAt || null,
      contentTier: data.contentTier || null,
      fetchAttempts: Array.isArray(data.fetchAttempts) ? data.fetchAttempts.length : 0,
    };
  } catch (e) {
    return { filePath, error: e.message };
  }
}

/**
 * Run collect-review-texts.js as a child process targeted at the batch.
 *
 * IMPORTANT: SHOW_FILTER + REVIEW_FILTER produce a cross-product (every
 * showId × every filename gets considered if the file exists). For a batch
 * with N shows × M filenames this can blow up to N*M files processed when
 * we only wanted the original N+M cohort entries. To avoid this, we group
 * the batch by showId and spawn one collector invocation per group, with
 * SHOW_FILTER set to ONLY that show. This keeps file scope to exactly the
 * cohort entries (or the immediate group of a single show).
 */
async function runCollectorForBatch(batch) {
  // Group by showId so SHOW_FILTER × REVIEW_FILTER stays precise per spawn
  const groups = new Map();
  for (const t of batch) {
    if (!groups.has(t.showId)) groups.set(t.showId, []);
    groups.get(t.showId).push(t);
  }

  const startTs = Date.now();
  let totalCode = 0;
  let groupIdx = 0;
  for (const [showId, items] of groups.entries()) {
    groupIdx++;
    const filenames = [...new Set(items.map(t => t.file))];
    const env = {
      SHOW_FILTER: showId,
      REVIEW_FILTER: filenames.join(','),
      BATCH_SIZE: '5',
      MAX_REVIEWS: String(filenames.length + 5), // tight cap
      PUSH_EVERY_N_BATCHES: '999999', // disable git push from inside child
      GITHUB_ACTIONS: '', // ensure no auto-push pathway
    };
    console.log(`  → [group ${groupIdx}/${groups.size}] show=${showId}, files=${filenames.length}`);
    const code = await runChild('node', [path.join(__dirname, 'collect-review-texts.js')], { env });
    if (code !== 0) totalCode = code;
  }

  const elapsedSec = ((Date.now() - startTs) / 1000).toFixed(1);
  console.log(`  ← batch finished: ${groups.size} group(s) in ${elapsedSec}s`);
  return { code: totalCode, elapsedSec };
}

/**
 * Stamp metadata on review files that just got recovered.
 */
function stampRecoveryMetadata(filePath, tier) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.recoveredAt = new Date().toISOString();
    data.recoveredVia = tier || data.fetchMethod || data.sourceMethod || 'unknown';
    data.recoveredFromCohort = COHORT_TAG;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    return true;
  } catch (e) {
    console.error(`  ⚠ Failed to stamp metadata on ${filePath}: ${e.message}`);
    return false;
  }
}

function saveProgress(state) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(state, null, 2) + '\n');
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();

  console.log('='.repeat(70));
  console.log('S3 Phase B — Cohort Recovery Wrapper');
  console.log('='.repeat(70));
  console.log(`Cohort:       ${args.cohort}`);
  console.log(`Batch size:   ${args['batch-size']}`);
  console.log(`Limit:        ${args.limit || 'no limit'}`);
  console.log(`Dry run:      ${args['dry-run'] ? 'YES' : 'no'}`);
  console.log(`Resume:       ${args.resume ? 'YES' : 'no'}`);
  console.log(`Max cost:     $${args['max-cost']}`);

  // Load cohort
  const cohort = loadCohort(args.cohort);
  console.log(`Loaded cohort: ${cohort.length} entries`);

  // Filter already-recovered
  const { remaining, alreadyRecovered, missing } = filterAlreadyRecovered(cohort);
  console.log(`  Already recovered (>1000 chars on disk): ${alreadyRecovered.length}`);
  console.log(`  Missing review files: ${missing.length}`);
  console.log(`  Remaining to process: ${remaining.length}`);

  // Resume: skip files already attempted in prior progress
  let processed = new Set();
  let prior = null;
  if (args.resume) {
    prior = loadProgress();
    if (prior) {
      processed = new Set((prior.attempted || []).map(a => `${a.showId}/${a.file}`));
      console.log(`  Resuming: ${processed.size} files marked attempted in prior run`);
    }
  }

  let queue = remaining.filter(t => !processed.has(`${t.showId}/${t.file}`));

  // Hand-pick diverse 20 if requested
  if (args['diverse-canary'] && (args.limit === 20 || args.limit === 0)) {
    queue = pickDiverseSubset(queue, args.limit || 20);
    console.log(`  Diverse canary subset: ${queue.length} entries`);
  } else if (args.limit > 0) {
    queue = queue.slice(0, args.limit);
    console.log(`  Limited to: ${queue.length} entries`);
  }

  if (queue.length === 0) {
    console.log('Nothing to process. Exiting.');
    process.exit(0);
  }

  // Dry run: print and exit
  if (args['dry-run']) {
    console.log('\n=== DRY RUN — Targets ===');
    for (const t of queue) {
      console.log(`  ${t.showId}/${t.file}  outlet=${t.outletId}  url=${(t.url || '').slice(0, 80)}`);
    }
    console.log(`\n${queue.length} target(s) would be processed in ${Math.ceil(queue.length / args['batch-size'])} batch(es).`);
    process.exit(0);
  }

  // Pre-flight
  if (!args['skip-preflight']) {
    await preflightBudget({ minCredits: 20000 });
  }

  // Set marker (estimate batches × 5 min + 1 hr buffer)
  const numBatches = Math.ceil(queue.length / args['batch-size']);
  const markerHours = Math.max(1, Math.ceil((numBatches * 5) / 60) + 1);
  await setRecoveryMarker(markerHours, 'S3 Phase B cohort recovery');

  // Track everything
  const state = {
    startedAt,
    cohort: args.cohort,
    cohortTag: COHORT_TAG,
    cohortSize: cohort.length,
    alreadyRecoveredCount: alreadyRecovered.length,
    missingCount: missing.length,
    queueSize: queue.length,
    batchSize: args['batch-size'],
    batches: prior ? (prior.batches || []) : [],
    attempted: prior ? (prior.attempted || []) : [],
    successes: prior ? (prior.successes || []) : [],
    failures: prior ? (prior.failures || []) : [],
    tierBreakdown: prior ? (prior.tierBreakdown || {}) : {},
    estimatedCostUsd: prior ? (prior.estimatedCostUsd || 0) : 0,
    interrupted: false,
    completedAt: null,
  };

  // Interrupt handling
  let interrupted = false;
  process.on('SIGINT', () => {
    console.log('\n⚠ SIGINT received — finishing current batch then aborting');
    interrupted = true;
  });
  process.on('SIGTERM', () => {
    console.log('\n⚠ SIGTERM received — finishing current batch then aborting');
    interrupted = true;
  });

  // Process in batches
  for (let i = 0; i < queue.length; i += args['batch-size']) {
    if (interrupted) break;
    if (state.estimatedCostUsd > args['max-cost']) {
      console.error(`\n❌ Estimated cost $${state.estimatedCostUsd.toFixed(2)} exceeds max $${args['max-cost']}. Aborting.`);
      state.interrupted = true;
      state.abortReason = 'max-cost-exceeded';
      break;
    }

    const batch = queue.slice(i, i + args['batch-size']);
    const batchIndex = Math.floor(i / args['batch-size']) + 1;
    console.log(`\n${'='.repeat(70)}`);
    console.log(`BATCH ${batchIndex}/${numBatches} — ${batch.length} files`);
    console.log('='.repeat(70));

    // Pre-snapshot
    const preSnapshots = batch.map(t => ({ ...t, pre: readReviewSnapshot(t.showId, t.file) }));

    // Run child
    const batchStart = Date.now();
    const { code, elapsedSec } = await runCollectorForBatch(batch);
    const batchDurationSec = ((Date.now() - batchStart) / 1000).toFixed(1);

    // Post-snapshot + classify outcomes
    const batchResult = {
      index: batchIndex,
      size: batch.length,
      childExit: code,
      durationSec: parseFloat(batchDurationSec),
      successes: 0,
      failures: 0,
      perFile: [],
    };
    for (const entry of preSnapshots) {
      const post = readReviewSnapshot(entry.showId, entry.file);
      const preLen = entry.pre ? entry.pre.fullTextLength : 0;
      const postLen = post ? post.fullTextLength : 0;
      const grew = postLen >= 1000 && postLen > preLen;
      const tier = post ? (post.collectedVia || post.fetchMethod || post.sourceMethod || 'unknown') : 'unknown';

      const fileRecord = {
        showId: entry.showId,
        file: entry.file,
        outletId: entry.outletId,
        url: entry.url,
        preChars: preLen,
        postChars: postLen,
        tier,
        success: grew,
      };

      if (grew) {
        batchResult.successes++;
        // Stamp metadata
        if (post && post.filePath) {
          stampRecoveryMetadata(post.filePath, tier);
        }
        state.successes.push(fileRecord);
      } else {
        batchResult.failures++;
        state.failures.push({
          ...fileRecord,
          reason: post ? (post.error ? `read-error: ${post.error}` : 'no growth') : 'file-missing',
        });
      }

      state.tierBreakdown[tier] = (state.tierBreakdown[tier] || 0) + 1;
      state.estimatedCostUsd += TIER_COST_USD[tier] !== undefined ? TIER_COST_USD[tier] : TIER_COST_USD.unknown;
      state.attempted.push({ showId: entry.showId, file: entry.file });
      batchResult.perFile.push(fileRecord);
    }

    state.batches.push(batchResult);
    console.log(`\nBatch ${batchIndex} result: ${batchResult.successes}/${batch.length} succeeded (${batchResult.failures} failed)`);
    console.log(`  Running totals: ${state.successes.length} success / ${state.failures.length} fail / $${state.estimatedCostUsd.toFixed(2)} est`);

    saveProgress(state);

    // Mid-run budget check (skip after the last batch)
    if (i + args['batch-size'] < queue.length && !args['skip-preflight']) {
      try {
        await preflightBudget({ minCredits: 10000 });
      } catch (e) {
        console.error(`Budget pre-flight failed mid-run: ${e.message}`);
        state.interrupted = true;
        state.abortReason = 'mid-run-budget-fail';
        break;
      }
    }
  }

  state.completedAt = new Date().toISOString();
  state.interrupted = state.interrupted || interrupted;

  // Clear marker
  await clearRecoveryMarker();

  // Write final report
  const utcTimestamp = state.completedAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const reportPath = path.join(AUDIT_DIR, `recovery-results-${utcTimestamp}.json`);
  const totalAttempted = state.successes.length + state.failures.length;
  const successRate = totalAttempted > 0 ? state.successes.length / totalAttempted : 0;

  const report = {
    _meta: {
      cohort: args.cohort,
      cohortTag: COHORT_TAG,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      interrupted: state.interrupted,
      abortReason: state.abortReason || null,
      durationSec: ((new Date(state.completedAt) - new Date(state.startedAt)) / 1000).toFixed(1),
    },
    summary: {
      cohortSize: state.cohortSize,
      alreadyRecovered: state.alreadyRecoveredCount,
      missing: state.missingCount,
      queued: state.queueSize,
      attempted: totalAttempted,
      succeeded: state.successes.length,
      failed: state.failures.length,
      successRate,
      estimatedCostUsd: state.estimatedCostUsd,
    },
    tierBreakdown: state.tierBreakdown,
    batches: state.batches,
    successes: state.successes,
    failures: state.failures,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${'='.repeat(70)}`);
  console.log('FINAL REPORT');
  console.log('='.repeat(70));
  console.log(`Attempted:    ${totalAttempted}`);
  console.log(`Succeeded:    ${state.successes.length} (${(successRate * 100).toFixed(1)}%)`);
  console.log(`Failed:       ${state.failures.length}`);
  console.log(`Est. cost:    $${state.estimatedCostUsd.toFixed(2)}`);
  console.log(`Tier breakdown:`);
  for (const [tier, count] of Object.entries(state.tierBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tier.padEnd(20)} ${count}`);
  }
  console.log(`\nReport: ${reportPath}`);
  if (state.interrupted) {
    console.log('\n⚠ Run was interrupted; resume with --resume');
    process.exit(3);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  // Try to clear marker on fatal
  runChild('node', [path.join(__dirname, 'recovery-marker.js'), 'clear']).catch(() => {});
  process.exit(2);
});
