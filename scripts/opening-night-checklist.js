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
const {
  collectRemediations,
  readAttempts,
  readGiveUps,
  planRemediations,
  executeRemediations,
  findAbandonedRemediations,
  dispatchWorkflow,
} = require('./lib/opening-night-remediation.js');
const { routeAlert } = require('./lib/owner-alert-router.js');

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
function computeCompositeForShow(showReviews, showCategory, showType) {
  const result = computeCriticScore(showReviews, _ocOutletRegistry, showCategory, showType);
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
    const compositeScore = computeCompositeForShow(reviewsDoc[show.id] || [], show.category, show.type);
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
        logRemediation({ at: now.toISOString(), kind: 'stub', showId: show.id, action: 'killed', reason: 'OPENING_NIGHT_REMEDIATION_DISABLED', outletId: m.outletId, criticName: m.criticName, url: m.url, source: m.source });
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

      // kind:'stub' distinguishes these from the workflow/alert remediations
      // that share this ledger (task #389) — one ledger, discriminated by kind,
      // rather than a second cooldown store.
      const base = { at: now.toISOString(), kind: 'stub', showId: show.id, outletId: m.outletId, criticName: m.criticName, url: m.url, source: m.source };
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

// ---------------------------------------------------------------------------
// Self-declared remediation — the 2026-04-15 catches (task #389)
// ---------------------------------------------------------------------------
// Sibling of remediateMissingReviews above, for the checks whose fix is "run
// the workflow that already owns this" or "tell the owner", rather than "write
// a stub review file". Same structural contract: a check opts in by emitting
// details.remediation; this function never switches on check name. See
// scripts/lib/opening-night-remediation.js for the full rationale.
async function runSelfDeclaredRemediations(showResults, now) {
  const remediations = collectRemediations(showResults);
  if (remediations.length === 0) return null;

  let ledgerLines = [];
  try {
    ledgerLines = fs.readFileSync(REMEDIATION_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  } catch (_) { /* first run — no ledger yet */ }

  const planned = planRemediations(remediations, readAttempts(ledgerLines), now, {
    gaveUpKeys: readGiveUps(ledgerLines),
  });

  const stats = await executeRemediations(planned, {
    now,
    dispatchWorkflow,
    routeAlert,
    appendLedger: logRemediation,
    disabled: process.env.OPENING_NIGHT_REMEDIATION_DISABLED === 'true',
  });

  console.log(`[remediation] self-declared: considered=${stats.considered} dispatched=${stats.dispatched} alerted=${stats.alerted} suppressed=${stats.suppressed} waited=${stats.waited} escalated=${stats.escalated} gaveUp=${stats.gaveUp} retired=${stats.retired} failed=${stats.failed} killed=${stats.killed}`);

  return {
    ...stats,
    // Plan detail rides in the ONE JSON payload so the run is auditable even
    // when the ledger commit later fails.
    actions: planned.map(({ remediation, action, waitMs }) => ({
      showId: remediation.showId,
      check: remediation.checkName,
      kind: remediation.kind,
      key: remediation.key,
      action,
      ...(remediation.workflow ? { workflow: remediation.workflow } : {}),
      ...(waitMs != null ? { waitMs } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Drain pass — terminalize remediations abandoned by the ±2-day window (task #1223)
// ---------------------------------------------------------------------------
// resolveTargetShows() only re-collects remediations from shows currently in
// the ±2-day window, so a key whose show ages out mid-remediation just stops
// being looked at: no lifetime-ceiling line, no ledger activity at all,
// forever. Ledger silence then reads as "resolved" when it may mean
// "abandoned". This pass scans the FULL ledger for keys stuck on an open
// action whose show is no longer targeted this run, and writes exactly one
// terminal line each.
//
// Only meaningful on a full run — a --show=ID run only ever sees one show, so
// every OTHER key's showId would look "not in this run's targets" even though
// it just wasn't asked about, which would wrongly terminalize the entire
// ledger the first time anyone ran with --show.
function runDrainPass(showResults, now) {
  if (showIdArg) return null;
  // Same kill switch remediateMissingReviews() and runSelfDeclaredRemediations()
  // already honor — if the owner has disabled the remediation layer (e.g.
  // mid-incident), the drain pass should not write new ledger state either.
  if (process.env.OPENING_NIGHT_REMEDIATION_DISABLED === 'true') return null;

  let ledgerLines = [];
  try {
    ledgerLines = fs.readFileSync(REMEDIATION_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  } catch (_) { return null; }

  const targetShowIds = new Set(showResults.map(({ show }) => show.id));
  const abandoned = findAbandonedRemediations(ledgerLines, targetShowIds, now);

  for (const item of abandoned) {
    logRemediation({
      at: now.toISOString(),
      kind: item.kind,
      key: item.key,
      showId: item.showId,
      checkName: item.checkName,
      action: item.action,
      attempts: item.attempts,
      ...(item.workflow ? { workflow: item.workflow } : {}),
      why: item.why,
    });
  }

  const gaveUp = abandoned.filter(a => a.action === 'gave-up').length;
  const trulyAbandoned = abandoned.length - gaveUp;
  if (abandoned.length > 0) {
    console.log(`[remediation] drain: ${abandoned.length} key(s) left the ±2-day window still open — ${trulyAbandoned} abandoned, ${gaveUp} gave-up`);
  }
  return { considered: abandoned.length, abandoned: trulyAbandoned, gaveUp, keys: abandoned.map(a => a.key) };
}

// W2.0 diagnosis (task #1073, 2026-08-06): data/audit/opening-night-history.json
// stopped getting new entries on 2026-04-26 while this workflow kept reporting
// green ~5x/day. Root cause, reproduced locally by renaming node_modules/cheerio
// out of the way and re-running this exact script against real data:
//
//   opening-night-checklist.js (main(), the for-loop over targetShows) calls
//   runChecks() -> opening-night-checks/index.js's loadChecks(), which does an
//   UNGUARDED `require(checkFile)` for every *.check.js file — including
//   bww-rr-count-mismatch.check.js and dtli-count-mismatch.check.js, which both
//   `require('../../gather-reviews')` at module top level. gather-reviews.js in
//   turn top-level-requires ./lib/page-validator.js, which top-level-requires the
//   THIRD-PARTY npm package 'cheerio'. .github/workflows/opening-night-checklist.yml
//   has NEVER had an `npm ci`/`npm install` step in its entire git history (it uses
//   raw actions/setup-node@v5, not the shared ./.github/actions/setup-node
//   composite that every other workflow uses) — so node_modules never exists on
//   that job's runner, and `require('cheerio')` throws MODULE_NOT_FOUND.
//
//   That throw happens while loadChecks() is still synchronously loading check
//   files — it propagates past runChecks()/main() as an uncaught exception RAISED
//   DURING MODULE RESOLUTION, which Node prints via its own default handler
//   (`node:internal/modules/cjs/loader:...`) and exits 1 BEFORE this file's own
//   `main().catch()` wrapper (bottom of this file) ever gets a chance to run —
//   so appendToHistory() (below) is never reached, on effectively every run.
//   Confirmed against real CI logs: even before the 2026-08-04 change that added
//   a second, direct top-level `require('./gather-reviews.js')` to THIS file for
//   the remediation feature (which independently reproduces the identical crash),
//   the exact same raw Node crash trace was already present — just silently
//   merged into /tmp/checklist.json instead of the workflow log (the pre-2026-08-02
//   step used `> /tmp/checklist.json 2>&1`), where opening-night-sla-dispatch.js's
//   `JSON.parse` failure ("Unexpected token 'o', "node:intern"...") is the only
//   surviving fingerprint — itself swallowed by that script's own graceful
//   degradation. `continue-on-error: true` + `|| true` on the checklist step (see
//   the workflow's W2.1 fix) then hid all of this end to end.
//
//   Net effect: this bug is NOT primarily about the empty catch below (though
//   that WAS also a real, independent bug — a genuine write failure, e.g. disk
//   full or a bad HISTORY_FILE path, would be silently swallowed forever with no
//   trace anywhere). The real fix for the April 26 incident is workflow-level:
//   .github/workflows/opening-night-checklist.yml now runs `npm ci` (via the
//   shared setup-node composite action) so the require chain actually resolves,
//   AND the checklist step's exit code is no longer swallowed, so a FUTURE
//   regression of this class fails loudly instead of silently. This function's
//   catch is hardened below as defense in depth for the class of bug it was
//   originally meant to catch (a genuine write-time failure), and the
//   "0 target shows" early-exit path (see main(), a few dozen lines up) now also
//   calls appendToHistory() so a legitimate "checked, nothing in window" run is
//   still recorded instead of silently skipping the ledger entirely.
let historyAppendFailed = false;

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

// Shared by both call sites (the "0 target shows" early exit and the normal
// end-of-run path) so a write failure is reported and flagged identically
// either way — was previously an inline `try { appendToHistory(...) } catch
// (_) {}` at the normal call site that swallowed every error with zero signal.
function appendToHistorySafe(showResults, now) {
  try {
    appendToHistory(showResults, now);
  } catch (err) {
    console.error('::error::opening-night-history append failed: ' + err.message);
    historyAppendFailed = true;
  }
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
    // A "0 shows in window" run is still a completed, legitimate checklist run —
    // record it in history instead of skipping the ledger entirely (W2.2: this
    // early exit used to return before ever reaching appendToHistory below).
    appendToHistorySafe([], now);
    process.exit(historyAppendFailed ? 3 : 1);
  }

  // Snapshot before running checks (A6 requirement)
  recordDailySnapshot(targetShows);

  const context = {
    reviewsDoc,
    reviewTextsRoot: REVIEW_TEXTS_ROOT,
    driftState,
    criticConsensusDoc,
    now,
    shows,
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

  // Aggregator remediation — create stubs for reviews we're missing from BWW RR / DTLI.
  // Runs AFTER checks produce missingReviews in their details, BEFORE we print/append
  // history so both capture the remediation outcome. MUST run before the JSON print:
  // it used to dump a SECOND JSON object on stderr, and the checklist workflow's
  // `> /tmp/checklist.json 2>&1` merged it into the file — JSON.parse in
  // opening-night-sla-dispatch.js then threw on every real run, so activeShowIds
  // never scoped anything and the SLA paged on shows months away from opening
  // (2026-08-02 false P0 storm). Stats now ride inside the ONE JSON object.
  let remediationStats = null;
  try {
    remediationStats = remediateMissingReviews(showResults, now);
  } catch (err) {
    console.error('[remediation] fatal (non-blocking):', err.message);
  }

  // Self-declared remediations (task #389). Non-blocking for the same reason
  // the stub path is: a dispatch/alert failure must not lose the checklist
  // result the SLA dispatcher is waiting on.
  let selfDeclaredRemediation = null;
  try {
    selfDeclaredRemediation = await runSelfDeclaredRemediations(showResults, now);
  } catch (err) {
    console.error('[remediation] self-declared fatal (non-blocking):', err.message);
  }

  // Drain pass (task #1223) — must run AFTER self-declared remediations so it
  // reads the ledger including any lines just written above, and is equally
  // non-blocking for the same reason: a drain failure must not lose the
  // checklist result the SLA dispatcher is waiting on.
  let remediationDrain = null;
  try {
    remediationDrain = runDrainPass(showResults, now);
  } catch (err) {
    console.error('[remediation] drain fatal (non-blocking):', err.message);
  }

  if (jsonMode) {
    const payload = JSON.stringify({
      generatedAt: now.toISOString(),
      stage: stageArg,
      shows: showResults.map(({ show, results, summary }) => ({
        show: { id: show.id, title: show.title, openingDate: show.openingDate, compositeScore: show.compositeScore, reviewCount: show.reviewCount },
        results,
        summary,
      })),
      ...(remediationStats ? { remediation: remediationStats } : {}),
      // Additive key — opening-night-sla-dispatch.js reads only .shows (and
      // each show's .summary/.results), so this cannot change SLA scoping.
      ...(selfDeclaredRemediation ? { remediationActions: selfDeclaredRemediation } : {}),
      // Additive key (task #1223) — feeds the daily digest a visible count of
      // keys terminalized because their show left the targeting window.
      ...(remediationDrain ? { remediationDrain } : {}),
    }, null, 2);
    // --out=<file>: write the JSON to its own file so it can NEVER be
    // corrupted by log lines. The remediation step's scraper stack logs to
    // STDOUT (e.g. '[SB Call] {...}'), so even a clean stderr redirect left
    // /tmp/checklist.json unparseable — which silently un-scoped the SLA
    // dispatcher for its entire life (2026-08-02 false P0 storm).
    // Variable deliberately NOT named outPath/filePath/etc — those names are
    // on lint-write-routing.sh's review-texts write heuristic; this write
    // targets the caller-chosen JSON destination (e.g. /tmp/checklist.json),
    // never a review file.
    const outArg = args.find((a) => a.startsWith('--out='));
    if (outArg) {
      const checklistJsonDest = outArg.slice('--out='.length);
      fs.writeFileSync(checklistJsonDest, payload + '\n');
      console.log(`[checklist] JSON written to ${checklistJsonDest} (${payload.length} bytes)`);
    } else {
      console.log(payload);
    }
  } else {
    printHumanReadable(showResults);
  }

  // Append to history
  appendToHistorySafe(showResults, now);

  const hasErrors = showResults.some(({ summary }) => summary.errors > 0);
  if (historyAppendFailed) {
    // Distinct from the DESIGNED exit 1 "shows have errors" path below (W2.2) —
    // exit 3 signals an INFRASTRUCTURE failure (the history ledger write itself
    // failed) that the caller must not treat as "routine gaps, continue as
    // normal". See the "Run opening night checklist" step in
    // .github/workflows/opening-night-checklist.yml for the rc handling.
    process.exit(3);
  }
  process.exit(hasErrors ? 1 : 0);
}

main().catch(err => {
  console.error('opening-night-checklist fatal error:', err.message);
  process.exit(1);
});
