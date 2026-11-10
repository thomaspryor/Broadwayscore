#!/usr/bin/env node
'use strict';

/**
 * recover-expected-critics.js (BRO-7312): search for every missing
 * expected-critic review before the owner ever hears about it.
 *
 *   node scripts/recover-expected-critics.js                  # due cells, real searches, saves state
 *   node scripts/recover-expected-critics.js --dry-run        # plan + SERP, no files, no state change
 *   node scripts/recover-expected-critics.js --plan-only      # print the plan, no network
 *   node scripts/recover-expected-critics.js --max-searches=3 --cells=show::outlet,show::outlet
 *
 * Per due cell (scripts/lib/expected-critics-recovery.js has the schedule) it
 * runs scripts/collect-outlet-reviews.js for exactly that show and outlet,
 * reads the per-cell result rows back (--result-json), and records the
 * attempt in data/audit/expected-critics-recovery.json. Written review files
 * go live through the normal rebuild; three empty searches over 14+ days
 * auto-ack the cell with the evidence; anything else ends as a plain-English
 * owner item in the health check.
 *
 * Exit 0 unless the state file could not be written (advisory, BRO-2123).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findExpectedCriticGaps } = require('./lib/expected-critics');
const { loadAcks } = require('./lib/t1-scoreboard');
const R = require('./lib/expected-critics-recovery');

const ROOT = path.join(__dirname, '..');
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/** Current gaps with the auto-acks applied, so acked cells read as not-reviewed. */
function currentGaps(state, nowMs) {
  return findExpectedCriticGaps({
    shows: readJson('data/shows.json').shows,
    reviews: readJson('data/reviews.json').reviews,
    outlets: readJson('data/outlet-registry.json').outlets,
    acks: R.mergedAcks(loadAcks(), state),
    nowMs,
  });
}

function runCollector(plan, { dryRun }) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ecr-')), 'result.json');
  const args = [path.join(__dirname, 'collect-outlet-reviews.js'), ...R.collectorArgs(plan, { resultJson: tmp, dryRun })];
  console.log(`\n$ node scripts/collect-outlet-reviews.js ${args.slice(1).join(' ')}`);
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', timeout: 10 * 60 * 1000 });
  if (res.status !== 0) console.warn(`collector exited ${res.status}${res.error ? ` (${res.error.message})` : ''}`);
  try {
    return JSON.parse(fs.readFileSync(tmp, 'utf8')).results || [];
  } catch {
    return []; // every planned cell records non_evidence
  }
}

function main() {
  const nowMs = Date.now();
  const dryRun = flag('dry-run');
  const planOnly = flag('plan-only');
  const maxSearches = Number(arg('max-searches') || 12);
  const only = arg('cells') ? new Set(arg('cells').split(',').filter(Boolean)) : null;

  let state = R.syncState(R.loadRecoveryState(), currentGaps(R.loadRecoveryState(), nowMs), nowMs);
  const scoped = only
    ? { ...state, cells: Object.fromEntries(Object.entries(state.cells).filter(([k]) => only.has(k))) }
    : state;
  const plans = R.planRecovery(scoped, nowMs, { maxSearches });
  const tracked = Object.keys(state.cells).length;
  console.log(`Expected-critics recovery: ${tracked} tracked cells, ${plans.reduce((n, p) => n + p.outletIds.length, 0)} due now (cap ${maxSearches})`);
  for (const p of plans) console.log(`  ${p.showId}: ${p.outletIds.join(', ')}`);
  if (planOnly) return;

  for (const plan of plans) {
    const rows = runCollector(plan, { dryRun });
    for (const r of rows) console.log(`  result ${r.showId}::${r.outletId} ${r.outcome}${r.reason ? ` (${r.reason})` : ''}${r.url ? ` ${r.url}` : ''}`);
    state = R.applyResults(state, { plan, rows, nowMs: Date.now(), dryRun });
  }
  if (dryRun) { console.log('\n--dry-run: state not saved'); return; }

  fs.mkdirSync(path.dirname(R.STATE_PATH), { recursive: true });
  fs.writeFileSync(R.STATE_PATH, `${JSON.stringify(state, null, 2)}\n`); // single writer (BRO-7312)
  const phases = {};
  for (const cell of Object.values(state.cells)) {
    const p = R.cellPhase(cell, Date.now()).phase;
    phases[p] = (phases[p] || 0) + 1;
  }
  console.log(`\nSaved ${path.relative(ROOT, R.STATE_PATH)}: ${Object.entries(phases).map(([k, v]) => `${k} ${v}`).join(', ') || 'empty'}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.stack || e.message); process.exit(1); }
}

module.exports = { currentGaps };
