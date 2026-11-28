#!/usr/bin/env node
'use strict';

/**
 * audit-lane-trouble-rate.js — per-lane trouble rate over a window (BRO-2978).
 * Shows retry burn the success/dead-rate audits hide. Logic: scripts/lib/lane-trouble-rate.js.
 *
 * Usage: node scripts/audit-lane-trouble-rate.js [--days=7] [--json]
 */

const fs = require('fs');
const path = require('path');
const { computeLaneTroubleRate } = require('./lib/lane-trouble-rate.js');
// Canonical repo root, NOT __dirname-relative: from a worktree the relative
// path reads an empty data/audit and reports 0% (same reason as
// audit-dispatch-dead-rate.js).
const { MAIN_REPO_ROOT: REPO } = require('./lib/repo-root');
const LEDGER = path.join(REPO, 'data', 'audit', 'dispatch-ledger.jsonl');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function main() {
  const windowDays = Number(arg('days', 7));
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    console.error(`--days must be a positive number (got ${arg('days', '')})`);
    process.exit(2);
  }
  if (!fs.existsSync(LEDGER)) {
    console.error(`No dispatch ledger at ${LEDGER} (gitignored, per-machine). Nothing to measure from this environment.`);
    process.exit(2);
  }
  const entries = fs.readFileSync(LEDGER, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const stats = computeLaneTroubleRate(entries, { nowMs: Date.now(), windowDays });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(stats, null, 2)); return; }
  console.log(`\nLane trouble rate, last ${windowDays}d (since ${stats.windowStartIso.slice(0, 16).replace('T', ' ')}Z)\n`);
  for (const [lane, L] of Object.entries(stats.lanes)) {
    const ev = Object.entries(L.events).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    console.log(`  ${lane}: ${L.troubledTasks}/${L.tasks} tasks troubled (${(L.troubledTaskRate * 100).toFixed(1)}%), ${L.troubledLaunches}/${L.launches} launches (${(L.troubledLaunchRate * 100).toFixed(1)}%)  [${ev}]`);
  }
  if (!Object.keys(stats.lanes).length) console.log('  no launches in window');
  console.log('');
}

main();
