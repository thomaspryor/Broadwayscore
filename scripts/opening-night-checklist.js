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
const { createReviewFile } = require('./gather-reviews.js');

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

// v5 (2026-04-29): pass outletRegistry + showCategory so per-region tier and
// off-market multiplier apply. Also fixes pre-v5 bug where outletRegistry was
// never passed (registry-fallback path was dead — every long-tail outlet
// silently treated as DEFAULT_TIER).
const _ocOutletRegistry = (() => {
  try { return require('../data/outlet-registry.json').outlets || {}; } catch { return {}; }
})();
function computeCompositeForShow(showReviews, showCategory) {
  const result = computeCriticScore(showReviews, _ocOutletRegistry, showCategory);
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
    const compositeScore = computeCompositeForShow(reviewsDoc[show.id] || [], show.category);
    const reviewCount = (reviewsDoc[show.id] || []).length;
    return [{ ...show, compositeScore, reviewCount }];
  }

  return shows
    .filter(s => isWithinTwoDays(s.openingDate, now))
    .map(s => ({
      ...s,
      compositeScore: computeCompositeForShow(reviewsDoc[s.id] || [], s.category),
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

// ---------------------------------------------------------------------------
// Aggregator remediation — proactive stub creation
// ---------------------------------------------------------------------------
// When bww-rr-count-mismatch or dtli-count-mismatch checks find reviews on
// the aggregator we don't have locally, they return `details.missingReviews`.
// This helper walks those, creates stub review files via createReviewFile
// (the canonical write primitive — already has all 12 guards). Stubs get
// picked up by the existing collect-review-texts → rebuild → score → deploy
// chain.
//
// Safety:
//   - Dedup handled by findExistingReviewFile inside each check + createReviewFile's own url-dedup
//   - Kill-switch via OPENING_NIGHT_REMEDIATION_DISABLED env var
//   - Every action logged to data/audit/remediation-log.jsonl
//   - Uses createReviewFile's guards (junk outlet, cross-market, wrong show, etc.)
const REMEDIATION_LOG_PATH = path.join(DATA_DIR, 'audit', 'remediation-log.jsonl');

function logRemediation(entry) {
  try {
    fs.mkdirSync(path.dirname(REMEDIATION_LOG_PATH), { recursive: true });
    fs.appendFileSync(REMEDIATION_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (_) { /* non-fatal */ }
}

function remediateMissingReviews(showResults, now) {
  const disabled = process.env.OPENING_NIGHT_REMEDIATION_DISABLED === 'true';
  const stats = { shows: 0, considered: 0, created: 0, skipped: 0, rejected: 0, killed: 0 };

  for (const { show, results } of showResults) {
    const missingAcross = [];
    for (const r of results) {
      const m = r?.details?.missingReviews;
      if (Array.isArray(m) && m.length > 0) missingAcross.push(...m);
    }
    if (missingAcross.length === 0) continue;
    stats.shows++;

    // Dedup missing reviews across checks (e.g. same outlet+critic listed on
    // both BWW RR and DTLI) — key on (outletId, criticName, url).
    const seen = new Set();
    const dedup = [];
    for (const m of missingAcross) {
      const key = `${m.outletId}|${m.criticName || ''}|${m.url || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(m);
    }

    for (const m of dedup) {
      stats.considered++;

      if (disabled) {
        stats.killed++;
        logRemediation({ at: now.toISOString(), showId: show.id, action: 'killed', reason: 'OPENING_NIGHT_REMEDIATION_DISABLED', outletId: m.outletId, criticName: m.criticName, url: m.url, source: m.source });
        continue;
      }

      // Build stub review data matching the established stub shape
      // (see scripts/create-stubs-from-reviews-json.js:72-91).
      const reviewData = {
        outlet: m.outlet || m.outletId,
        outletId: m.outletId,
        criticName: m.criticName || null,
        url: m.url || null,
        source: m.source,            // 'bww-rr-remediation' or 'dtli-remediation'
        contentTier: 'stub',
        incompleteReason: m.url ? 'no_text' : 'no_url',
        fullText: '',
        createdAt: now.toISOString(),
      };

      // createReviewFile returns:
      //   - true       → file written
      //   - false      → no-op (usually duplicate URL already assigned elsewhere)
      //   - string     → rejected by a guard (e.g. 'junkOutlet', 'wrongProduction',
      //                  'tourReview', 'crossMarketBroadway', 'profileUrl', etc.)
      let result;
      let threw = null;
      try {
        const cat = show.category || 'broadway';
        result = createReviewFile(show.id, reviewData, {
          allowOffBroadway: cat === 'off-broadway',
          allowWestEnd: cat === 'west-end' || cat === 'off-west-end',
        });
      } catch (err) {
        threw = err.message;
      }

      const base = { at: now.toISOString(), showId: show.id, outletId: m.outletId, criticName: m.criticName, url: m.url, source: m.source };
      if (threw) {
        stats.rejected++;
        logRemediation({ ...base, action: 'rejected', reason: `threw: ${threw}` });
      } else if (result === true) {
        stats.created++;
        logRemediation({ ...base, action: 'created' });
      } else if (result === false) {
        stats.skipped++;
        logRemediation({ ...base, action: 'skipped', reason: 'noop (duplicate or existing file)' });
      } else if (typeof result === 'string') {
        stats.rejected++;
        logRemediation({ ...base, action: 'rejected', reason: result });
      } else {
        // Unknown shape — log and count as rejected so we don't claim success falsely
        stats.rejected++;
        logRemediation({ ...base, action: 'rejected', reason: `unknown return: ${typeof result}` });
      }
    }
  }

  if (stats.considered > 0) {
    console.log(`\n[remediation] ${stats.shows} show(s), considered=${stats.considered} created=${stats.created} skipped=${stats.skipped} rejected=${stats.rejected} killed=${stats.killed}`);
  }
  return stats;
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

  // Aggregator remediation — create stubs for reviews we're missing from BWW RR / DTLI.
  // Runs AFTER checks produce missingReviews in their details, BEFORE we append history
  // so the history captures the remediation outcome too.
  let remediationStats = null;
  try {
    remediationStats = remediateMissingReviews(showResults, now);
  } catch (err) {
    console.error('[remediation] fatal (non-blocking):', err.message);
  }

  // Append to history
  try { appendToHistory(showResults, now); } catch (_) {}

  // Surface remediation stats in JSON output too
  if (jsonMode && remediationStats) {
    // Appended to previous JSON; easier: dump on stderr so stdout stays clean single-JSON
    process.stderr.write(JSON.stringify({ remediation: remediationStats }) + '\n');
  }

  const hasErrors = showResults.some(({ summary }) => summary.errors > 0);
  process.exit(hasErrors ? 1 : 0);
}

main().catch(err => {
  console.error('opening-night-checklist fatal error:', err.message);
  process.exit(1);
});
