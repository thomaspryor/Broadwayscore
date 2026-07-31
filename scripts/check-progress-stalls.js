#!/usr/bin/env node
'use strict';

/**
 * check-progress-stalls.js — LIVENESS monitor (task #597): detects registered
 * pipeline counters that have stopped moving even though every
 * existence/safety check on them still passes. Complements
 * check-corpus-drift.js (thresholds, not motion).
 *
 * Uses the existing weekly-monitor-runner.js rails (loadData/decideFn/
 * statePath) rather than a bespoke CLI/state mechanism (second-opinion
 * review, task #597, 2026-07-30) — decideProgress below is exported and unit
 * tested directly (CLAUDE.md rule 15), independent of the runner.
 *
 * State is COMMITTED (data/audit/progress-watch-state.json), like
 * corpus-drift.json and card-verifiability.json — this monitor runs from
 * fresh CI checkouts on different machines/runs, so history must survive in
 * git, not on one Mac (contrast dispatch-ledger.jsonl, which is gitignored
 * because its producer+consumer share one Mac via launchd).
 *
 * Surfaces registered so far:
 *   - needsRescoreUnblocked — the queue depth that sat at 141 for ~6 days
 *     (scripts/lib/rescore-lifecycle.js header) before that bug was fixed.
 *     Counts ONLY unblocked work (see scripts/lib/rescore-queue-depth.js) —
 *     files parked by design via isBlockedFromRescore() are excluded so this
 *     monitor doesn't itself become permanently-stalled noise on the very
 *     queue that motivated it.
 *
 * This is a passive monitor (like check-corpus-drift.js): it never fails CI.
 * Stalled surfaces surface in the daily digest via health-check.js's
 * progressWatchResults().
 *
 * Usage:
 *   node scripts/check-progress-stalls.js               # run, write state, exit 0
 *   node scripts/check-progress-stalls.js --dry-run      # compute + print, don't persist
 *   node scripts/check-progress-stalls.js --state=PATH   # override state path (tests)
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { runWeeklyMonitor } = require('./lib/weekly-monitor-runner');
const { assertProgress } = require('./lib/progress-watch');
const { computeRescoreQueueDepth } = require('./lib/rescore-queue-depth');

const USAGE = `check-progress-stalls.js — liveness monitor: has a registered pipeline counter stopped moving?

Usage:
  node scripts/check-progress-stalls.js [options]
  node scripts/check-progress-stalls.js --help, -h    print this usage and exit

Options:
  --dry-run       compute + print, don't persist state
  --state=PATH    override state file path (tests)
`;

const ROOT = path.join(__dirname, '..');
const STATE_PATH_DEFAULT = path.join(ROOT, 'data', 'audit', 'progress-watch-state.json');

// One row per registered surface. Add a row here + a value in loadData() to
// register a new call site — the primitive itself (progress-watch.js) never
// needs to change.
const SURFACES = [
  {
    key: 'needsRescoreUnblocked',
    label: 'needsRescore queue (unblocked)',
    cycles: 3,
    direction: 'down',
    hint: 'node scripts/audit-stuck-rescore-flags.js --json for a byReason breakdown; if this is pinned, confirm llm-ensemble-score.yml\'s "Drain needsRescore backlog" step actually ran (not just scheduled) and that markRescoreComplete/stampTerminalScoringFailure are being called on every scoring outcome.',
  },
];

function loadShowTitles() {
  const showsPath = path.join(ROOT, 'data', 'shows.json');
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.shows || []);
  return new Map(arr.map((s) => [s.id, s.title]));
}

async function loadData() {
  const titleById = loadShowTitles();
  const { unblocked } = computeRescoreQueueDepth(path.join(ROOT, 'data', 'review-texts'), titleById);
  return { needsRescoreUnblocked: unblocked };
}

/**
 * Pure decideFn for weekly-monitor-runner's runWeeklyMonitor({loadData,
 * decideFn, statePath}). No alerts of its own — health-check.js's
 * progressWatchResults() is the one owner-facing surface (matching the
 * existing backlog-report pattern: obClosingBacklogResults et al also don't
 * alert directly). Unit tested directly, independent of the runner.
 *
 * @param {Object} data - current value per surface key, from loadData()
 * @param {Object} state - prior state (state.surfaces[key].history)
 * @param {number} now - epoch ms (injectable for tests)
 * @returns {{alerts: Array, state: Object}}
 */
function decideProgress(data, state, now) {
  const priorSurfaces = (state && state.surfaces) || {};
  const surfaces = {};
  for (const s of SURFACES) {
    const prior = priorSurfaces[s.key] || {};
    const result = assertProgress(prior.history || [], data[s.key], {
      cycles: s.cycles,
      direction: s.direction,
      ts: new Date(now).toISOString(),
    });
    surfaces[s.key] = { label: s.label, hint: s.hint, cycles: s.cycles, ...result };
  }
  return { alerts: [], state: { ...state, surfaces } };
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const dryRun = argv.includes('--dry-run');
  const stateArg = argv.find((a) => a.startsWith('--state='));
  const statePath = stateArg ? stateArg.split('=')[1] : STATE_PATH_DEFAULT;

  await runWeeklyMonitor({
    loadData,
    decideFn: decideProgress,
    statePath,
    dryRun,
    logData: (data) => console.log('[progress-watch] current values:', JSON.stringify(data)),
  });

  const state = dryRun
    ? decideProgress(await loadData(), (() => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } })(), Date.now()).state
    : JSON.parse(fs.readFileSync(statePath, 'utf8'));

  let anyStalled = false;
  for (const s of Object.values(state.surfaces || {})) {
    const icon = s.stalled ? '⚠️' : '✅';
    console.log(`${icon} ${s.label}: ${s.value} (${s.reason})`);
    if (s.stalled) anyStalled = true;
  }
  if (anyStalled) {
    console.log('[progress-watch] one or more surfaces stalled — see data/audit/progress-watch-state.json; health-check.js surfaces this in the daily digest.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[progress-watch] error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { decideProgress, loadData, SURFACES };
