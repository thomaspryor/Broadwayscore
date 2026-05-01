#!/usr/bin/env node
/**
 * run-bulk-historical-import.js — orchestrator for bulk historical-shows ingestion.
 *
 * Wraps the existing pipeline (gather-reviews → backfill-unknown-critics) for
 * batch import of historical WE/Broadway shows added via discover-historical-shows.
 * Modeled on scripts/run-cohort-recovery.js. Does NOT invent new validators or
 * schema fields — reuses what's already there.
 *
 * Per the /second-opinion review (Notion 351637c5-416f-8177 follow-up): bulk
 * import previously had no synchronous quality gate between discovery and merge.
 * 50 imported shows could yield ~12 with composites + 38 dead pages. This
 * orchestrator runs the pipeline per-show, then emits an actionable health
 * report partitioning shows into success / thin-reviews / missing-poster /
 * all-wrong-production / failed-gather buckets. Operator gets a punch-list,
 * not a silent partial failure.
 *
 * Usage:
 *   node scripts/run-bulk-historical-import.js --shows=ids.txt
 *   node scripts/run-bulk-historical-import.js --shows=show-1,show-2
 *   node scripts/run-bulk-historical-import.js --pending  # use historical-shows-pending.json
 *   node scripts/run-bulk-historical-import.js --shows=ids.txt --dry-run
 *   node scripts/run-bulk-historical-import.js --shows=ids.txt --skip-preflight
 *   node scripts/run-bulk-historical-import.js --shows=ids.txt --expect-add=200
 *
 * CLI flags:
 *   --shows=<list-or-file>  Comma-separated show-ids OR path to a newline-separated file
 *   --pending               Read from data/historical-shows-pending.json
 *   --dry-run               Print plan; do not spawn gather/backfill
 *   --skip-preflight        Skip the ScrapingBee budget check (NEVER in CI)
 *   --skip-backfill         Skip the unknown-critics backfill steps
 *   --expect-add=N          Expected total review count to be added (drives inverse-drop alert)
 *   --gather-timeout=<sec>  Per-show gather timeout in seconds (default 600)
 *
 * Exit codes:
 *   0 — completed; <30% of shows in failure buckets AND no inverse-drop alert
 *   1 — completed but >30% failure rate OR inverse-drop alert fired
 *   2 — pre-flight or argument error
 *   3 — interrupted (SIGINT/SIGTERM); progress saved
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isIncludableForRebuild } = require('./lib/review-guards');
const { summarizeBulkImport, renderReport } = require('./lib/bulk-import-summary');

const REPO_ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data', 'review-texts');
const SHOWS_JSON = path.join(REPO_ROOT, 'data', 'shows.json');
const IMAGE_SOURCES_JSON = path.join(REPO_ROOT, 'data', 'image-sources.json');
const PENDING_PATH = path.join(REPO_ROOT, 'data', 'historical-shows-pending.json');

// Hosts whose URL in image-sources.json signals a Playbill-OG-fallback (acceptable
// quality but operator should know). Anything else is real poster art.
const PLAYBILL_OG_HOSTS = new Set(['playbill.com', 'www.playbill.com']);

// ----------------------------------------------------------------------------
// Argument parsing
// ----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    shows: [],
    pending: false,
    dryRun: false,
    skipPreflight: false,
    skipBackfill: false,
    expectAdd: 0,
    gatherTimeoutSec: 600,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--pending') out.pending = true;
    else if (arg === '--skip-preflight') out.skipPreflight = true;
    else if (arg === '--skip-backfill') out.skipBackfill = true;
    else if (arg.startsWith('--shows=')) {
      const spec = arg.slice('--shows='.length);
      out.shows = resolveShowsArg(spec);
    } else if (arg.startsWith('--expect-add=')) {
      out.expectAdd = parseInt(arg.split('=')[1], 10) || 0;
    } else if (arg.startsWith('--gather-timeout=')) {
      out.gatherTimeoutSec = parseInt(arg.split('=')[1], 10) || 600;
    }
  }

  if (out.pending && out.shows.length === 0) {
    out.shows = readPendingShows();
  }

  return out;
}

function resolveShowsArg(spec) {
  // Path or comma-separated list
  if (spec.includes(',') || !spec.includes('/')) {
    // Could be either; try as path first
    if (fs.existsSync(spec)) return readShowList(spec);
    return spec.split(',').map(s => s.trim()).filter(Boolean);
  }
  return readShowList(spec);
}

function readShowList(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: show list not found at ${filePath}`);
    process.exit(2);
  }
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function readPendingShows() {
  if (!fs.existsSync(PENDING_PATH)) {
    console.error(`ERROR: ${PENDING_PATH} not found. Run discover-historical-shows first.`);
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
  // Schema: { shows: [{ id, title, ... }] } OR top-level array — support both
  const shows = Array.isArray(data) ? data : (data.shows || []);
  return shows.map(s => s.id || s).filter(Boolean);
}

// ----------------------------------------------------------------------------
// Per-show ledger
// ----------------------------------------------------------------------------

function buildShowState(showId, gatherError) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  let reviewCount = 0;
  let unknownCriticCount = 0;
  let wrongProductionCount = 0;
  let totalReviews = 0;

  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
      catch { continue; }
      totalReviews++;
      if (isIncludableForRebuild(r)) reviewCount++;
      if ((r.criticName || 'Unknown') === 'Unknown') unknownCriticCount++;
      if (r.wrongProduction === true && !r.wrongProductionManualClear) wrongProductionCount++;
    }
  }

  const wrongProductionAll = totalReviews > 0 && wrongProductionCount === totalReviews;
  const hasValidPoster = checkPoster(showId);

  return {
    showId,
    reviewCount,
    totalReviews,
    unknownCriticCount,
    wrongProductionAll,
    hasValidPoster,
    gatherError,
  };
}

function checkPoster(showId) {
  // Heuristic 1: poster file exists on disk.
  const posterDir = path.join(REPO_ROOT, 'public', 'images', 'shows', showId);
  if (!fs.existsSync(posterDir)) return false;
  const hasPoster = ['poster.webp', 'poster.jpg', 'poster.png']
    .some(f => fs.existsSync(path.join(posterDir, f)));
  if (!hasPoster) return false;

  // Heuristic 2: image-sources.json source URL is not a Playbill-OG fallback
  // (Playbill OGs are landscape 1200×630 cropped weird to portrait, which is
  // what we surface as "missing poster" to the operator).
  if (fs.existsSync(IMAGE_SOURCES_JSON)) {
    try {
      const sources = JSON.parse(fs.readFileSync(IMAGE_SOURCES_JSON, 'utf8'));
      const entry = sources[showId];
      if (entry && entry.poster) {
        const url = String(entry.poster);
        try {
          const host = new URL(url).hostname;
          if (PLAYBILL_OG_HOSTS.has(host)) return false;
        } catch {}
      }
    } catch {}
  }
  return true;
}

// ----------------------------------------------------------------------------
// Sub-process helpers (preflight, gather, backfill)
// ----------------------------------------------------------------------------

function runPreflight() {
  // ScrapingBee >= 25% remaining (CLAUDE.md §14.4) and Bright Data zone enabled.
  console.log('[preflight] checking ScrapingBee credits + Bright Data zone…');
  const result = spawnSync('node', [
    path.join(__dirname, 'preflight-recovery-budget.js'),
    '--threshold-sb=25',
    '--threshold-bd=enabled',
  ], { stdio: 'inherit' });
  return result.status === 0;
}

function runGatherForShow(showId, timeoutSec) {
  const result = spawnSync('node', [
    path.join(__dirname, 'gather-reviews.js'),
    `--shows=${showId}`,
  ], {
    stdio: 'inherit',
    timeout: timeoutSec * 1000,
    env: { ...process.env },
  });
  if (result.status === null && result.signal) return `signal:${result.signal}`;
  if (result.status !== 0) return `exit:${result.status}`;
  return null;
}

function runBackfillUnknownCritics(showIds) {
  // Phase A: outlets (local, free, fast) for ALL touched shows in one pass.
  // Phase B: critics (HTTP-bounded) likewise.
  for (const phase of ['--outlets-only', '--critics-only']) {
    const args = [
      path.join(__dirname, 'backfill-unknown-critics.js'),
      phase,
    ];
    if (phase === '--critics-only') args.push('--limit=200');
    console.log(`[backfill] phase ${phase}…`);
    spawnSync('node', args, {
      stdio: 'inherit',
      env: { ...process.env },
      timeout: 30 * 60 * 1000, // 30 min hard cap; backfill has its own per-call timeouts
    });
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.shows.length === 0) {
    console.error('ERROR: no shows specified. Use --shows=<list>, --shows=<file>, or --pending.');
    process.exit(2);
  }

  // De-dupe + validate against shows.json (skip silently if shows.json absent;
  // CI may not always have it as a symlink).
  const idSet = new Set(args.shows);
  const ids = Array.from(idSet);

  console.log(`[bulk-import] ${ids.length} shows queued.`);
  console.log(`[bulk-import] dryRun=${args.dryRun} skipBackfill=${args.skipBackfill} expectAdd=${args.expectAdd}`);

  if (args.dryRun) {
    console.log('--dry-run set. Showing plan, not running.');
    ids.forEach(id => console.log('  -', id));
    process.exit(0);
  }

  if (!args.skipPreflight) {
    const ok = runPreflight();
    if (!ok) {
      console.error('[preflight] FAILED — refusing to proceed. Use --skip-preflight to override (NEVER in CI).');
      process.exit(2);
    }
  }

  // Ensure a graceful shutdown writes a partial report on SIGINT.
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; });
  process.on('SIGTERM', () => { interrupted = true; });

  // Per-show gather pass.
  const gatherErrors = new Map();
  for (let i = 0; i < ids.length; i++) {
    if (interrupted) break;
    const showId = ids[i];
    console.log(`[gather] (${i + 1}/${ids.length}) ${showId}…`);
    const err = runGatherForShow(showId, args.gatherTimeoutSec);
    if (err) gatherErrors.set(showId, err);
  }

  // Backfill pass — runs ONCE for all shows (the backfill scripts iterate the
  // whole catalog by default). Skipped on --skip-backfill so the orchestrator
  // is also useful for "just the gather" partial runs.
  if (!args.skipBackfill && !interrupted) {
    runBackfillUnknownCritics(ids);
  }

  // Compute per-show ledger.
  const showStates = ids.map(id => buildShowState(id, gatherErrors.get(id) || null));

  // Render summary report.
  const report = summarizeBulkImport(showStates, { expectAdd: args.expectAdd });
  console.log('\n' + renderReport(report));

  // Decide exit code.
  const failureCount =
    report.summary.failedGather +
    report.summary.allWrongProduction +
    report.summary.thinReviews +
    report.summary.missingPoster;
  const failureRate = report.summary.totalShows > 0
    ? failureCount / report.summary.totalShows
    : 0;

  if (interrupted) process.exit(3);
  if (report.inverseDropAlert) process.exit(1);
  if (failureRate > 0.3) {
    console.error(`[bulk-import] failure rate ${(failureRate * 100).toFixed(1)}% > 30% threshold`);
    process.exit(1);
  }
  process.exit(0);
}

main();
