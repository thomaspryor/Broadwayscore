#!/usr/bin/env node
'use strict';

/**
 * Opening Night Checklist
 *
 * Usage:
 *   node scripts/opening-night-checklist.js [--show=ID] [--stage=T-12h|T-6h|T-2h|post-open] [--json]
 *
 * For each show opening within ±2 days (or a specific show), runs all automated
 * checks from scripts/lib/opening-night-checks/ and reports results.
 */

const fs = require('fs');
const path = require('path');

const { runChecks } = require('./lib/opening-night-checks/index.js');
const { recordDailySnapshot } = require('./lib/score-history-snapshot.js');
const { computeCriticScore } = require('./lib/compute-critic-score.js');

const DATA_DIR = path.resolve(__dirname, '../data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const CRITIC_CONSENSUS_FILE = path.join(DATA_DIR, 'critic-consensus.json');
const DRIFT_STATE_FILE = path.join(DATA_DIR, 'audit', 'drift-state.json');
const HISTORY_FILE = path.join(DATA_DIR, 'audit', 'opening-night-history.json');
const REVIEW_TEXTS_ROOT = path.join(DATA_DIR, 'review-texts');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const showIdArg = (args.find(a => a.startsWith('--show=')) || '').replace('--show=', '') || null;
const stageArg = (args.find(a => a.startsWith('--stage=')) || '').replace('--stage=', '') || 'auto';
const jsonMode = args.includes('--json');

// ---------------------------------------------------------------------------
// Data loading helpers
// ---------------------------------------------------------------------------
function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  return data.shows || [];
}

function loadReviewsDoc(reviews) {
  // Group flat reviews array by showId
  const doc = {};
  for (const r of reviews) {
    if (!doc[r.showId]) doc[r.showId] = [];
    doc[r.showId].push(r);
  }
  return doc;
}

function loadCriticConsensus() {
  try {
    const data = JSON.parse(fs.readFileSync(CRITIC_CONSENSUS_FILE, 'utf8'));
    return data.shows || {};
  } catch (_) {
    return {};
  }
}

function loadDriftState() {
  try {
    return JSON.parse(fs.readFileSync(DRIFT_STATE_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function computeCompositeForShow(showReviews) {
  const result = computeCriticScore(showReviews);
  return result ? Math.round(result.s) : null;
}

// ---------------------------------------------------------------------------
// Show targeting
// ---------------------------------------------------------------------------
function isWithinTwoDays(openingDate, now) {
  if (!openingDate) return false;
  const diff = Math.abs(new Date(openingDate).getTime() - now.getTime());
  return diff <= 2 * 24 * 60 * 60 * 1000;
}

function resolveTargetShows(shows, reviewsDoc, now) {
  if (showIdArg) {
    const show = shows.find(s => s.id === showIdArg);
    if (!show) return [];
    const compositeScore = computeCompositeForShow(reviewsDoc[show.id] || []);
    const reviewCount = (reviewsDoc[show.id] || []).length;
    return [{ ...show, compositeScore, reviewCount }];
  }

  return shows
    .filter(s => isWithinTwoDays(s.openingDate, now))
    .map(s => ({
      ...s,
      compositeScore: computeCompositeForShow(reviewsDoc[s.id] || []),
      reviewCount: (reviewsDoc[s.id] || []).length,
    }));
}

// ---------------------------------------------------------------------------
// Drift subscriber (reads drift-state.json, does NOT re-run drift logic)
// ---------------------------------------------------------------------------
function buildDriftCheckResult(show, driftState) {
  const entry = driftState[show.id];
  if (!entry) {
    return {
      name: 'drift-detector',
      description: 'Drift detector subscription (reads data/audit/drift-state.json)',
      ok: true,
      severity: 'warning',
      message: `Drift state unavailable for ${show.id} — is check-opening-night-drift.yml running?`,
    };
  }
  const drift = entry.drift ?? 0;
  return {
    name: 'drift-detector',
    description: 'Drift detector subscription (reads data/audit/drift-state.json)',
    ok: drift <= 2,
    severity: drift > 5 ? 'error' : drift > 2 ? 'warning' : 'ok',
    message: drift <= 2
      ? `Drift ok (${drift}%)`
      : `Drift at ${drift}% — ${drift > 5 ? 'CRITICAL' : 'monitor'}`,
    details: { drift, showId: show.id },
  };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function printHumanReadable(showResults) {
  const severityLabel = { ok: 'OK  ', warning: 'WARN', error: 'FAIL' };
  for (const { show, results, summary } of showResults) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Show: ${show.title} (${show.id})`);
    console.log(`Opening: ${show.openingDate}  Score: ${show.compositeScore ?? 'N/A'}  Reviews: ${show.reviewCount ?? 0}`);
    console.log(`Stage: ${stageArg}  Summary: ${summary.errors} errors, ${summary.warnings} warnings, ${summary.ok} ok`);
    console.log('-'.repeat(60));
    for (const r of results) {
      console.log(`[${severityLabel[r.severity] || r.severity}] ${r.name}: ${r.message.split('\n')[0]}`);
      if (r.message.includes('\n')) {
        r.message.split('\n').slice(1).forEach(line => console.log(`       ${line}`));
      }
    }
  }
}

function appendToHistory(showResults, now) {
  let history = { runs: [] };
  if (fs.existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (_) {}
  }
  history.runs = history.runs || [];
  history.runs.push({
    at: now.toISOString(),
    stage: stageArg,
    shows: showResults.map(({ show, summary }) => ({
      showId: show.id,
      openingDate: show.openingDate,
      summary,
    })),
  });
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const now = new Date();

  // Load all data once
  const shows = loadShows();
  const reviewsRaw = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
  const reviewsDoc = loadReviewsDoc(reviewsRaw.reviews || []);
  const criticConsensusDoc = loadCriticConsensus();
  const driftState = loadDriftState();

  // Resolve target shows, enriched with compositeScore + reviewCount
  const targetShows = resolveTargetShows(shows, reviewsDoc, now);

  if (targetShows.length === 0) {
    const msg = showIdArg
      ? `Show '${showIdArg}' not found in shows.json`
      : 'No shows with openingDate within ±2 days';
    if (jsonMode) {
      console.log(JSON.stringify({ generatedAt: now.toISOString(), stage: stageArg, shows: [], error: msg }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  // Snapshot before running checks (A6 requirement)
  recordDailySnapshot(targetShows);

  const context = {
    reviewsDoc,
    reviewTextsRoot: REVIEW_TEXTS_ROOT,
    driftState,
    criticConsensusDoc,
    now,
  };

  const showResults = [];
  for (const show of targetShows) {
    const { results, summary } = await runChecks(show, context);
    // Add drift subscriber result
    const driftResult = buildDriftCheckResult(show, driftState);
    results.push(driftResult);
    if (driftResult.severity === 'error') summary.errors++;
    else if (driftResult.severity === 'warning') summary.warnings++;
    else summary.ok++;

    showResults.push({ show, results, summary });
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      generatedAt: now.toISOString(),
      stage: stageArg,
      shows: showResults.map(({ show, results, summary }) => ({
        show: { id: show.id, title: show.title, openingDate: show.openingDate, compositeScore: show.compositeScore, reviewCount: show.reviewCount },
        results,
        summary,
      })),
    }, null, 2));
  } else {
    printHumanReadable(showResults);
  }

  // Append to history
  try { appendToHistory(showResults, now); } catch (_) {}

  const hasErrors = showResults.some(({ summary }) => summary.errors > 0);
  process.exit(hasErrors ? 1 : 0);
}

main().catch(err => {
  console.error('opening-night-checklist fatal error:', err.message);
  process.exit(1);
});
