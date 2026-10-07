#!/usr/bin/env node
'use strict';

/**
 * audit-dispatch-dead-rate.js — print the dead-dispatch rate over a window.
 *
 * Card #1199. The whole point of the card is that a ~20% dead-launch rate was
 * invisible for a week because every session only ever saw its own 1-3
 * failures. This is the human-facing read of scripts/lib/dispatch-health.js —
 * and, critically, the tool that decides whether a CAUSE fix worked: a
 * 1-in-5 intermittent failure passes almost any single clean test dispatch, so
 * the only honest verdict is this rate before vs after, over many launches.
 *
 * All logic lives in the pure lib (CLAUDE.md rule 15) — this file is I/O and
 * formatting only.
 *
 * Usage:
 *   node scripts/audit-dispatch-dead-rate.js               # last 7 days, cmux lane
 *   node scripts/audit-dispatch-dead-rate.js --days=14
 *   node scripts/audit-dispatch-dead-rate.js --lane=headless
 *   node scripts/audit-dispatch-dead-rate.js --json
 */

const fs = require('fs');
const path = require('path');
const {
  computeDeadRate, computeDispatchHealthDigest, CMUX_LANE, DEFAULTS,
} = require('./lib/dispatch-health.js');

// Canonical repo root, NOT __dirname-relative (task #1904). Dispatches and
// sessions routinely run from worktrees under .claude/worktrees/, and a
// relative path resolves into the WORKTREE's own empty data/audit — so this
// tool, the human-facing read of the dead rate and the command this card's
// own recheck instructions name, printed "Nothing to measure from this
// environment" and exited 2 wherever it was actually run. Same hardcoded
// convention, for the same reason, as scripts/lib/dispatch-ledger.js:38 and
// scripts/verify-dispatch-dead-rate-recovery.test.mjs, both of which already
// documented that the ledger is one shared per-machine file.
const REPO = '/Users/tompryor/Broadwayscore';
const LEDGER = path.join(REPO, 'data', 'audit', 'dispatch-ledger.jsonl');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function main() {
  const asJson = process.argv.includes('--json');
  const windowDays = Number(arg('days', DEFAULTS.windowDays));
  const lane = arg('lane', CMUX_LANE);

  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    console.error(`--days must be a positive number (got ${arg('days', '')})`);
    process.exit(2);
  }

  if (!fs.existsSync(LEDGER)) {
    // Not a silent zero: dispatch-ledger.jsonl is gitignored and per-machine,
    // so an absent file means "no visibility here", never "no failures".
    console.error(`No dispatch ledger at ${LEDGER} — it is gitignored and per-machine, written only where dispatches actually launch. Nothing to measure from this environment.`);
    process.exit(2);
  }

  const entries = fs.readFileSync(LEDGER, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const nowMs = Date.now();
  const stats = computeDeadRate(entries, { nowMs, windowDays, lane });
  const row = computeDispatchHealthDigest({ entries, nowMs, windowDays, lane });

  if (asJson) {
    console.log(JSON.stringify({ ...stats, status: row.status, message: row.message }, null, 2));
    return;
  }

  const pct = (stats.deadRate * 100).toFixed(1);
  console.log(`\nDispatch dead-launch rate — lane "${lane}", last ${windowDays}d (since ${stats.windowStartIso.slice(0, 16).replace('T', ' ')}Z)\n`);
  console.log(`  ${stats.dead}/${stats.launches} launches never ran = ${pct}%   [${row.status.toUpperCase()}]`);
  if (stats.unverified) console.log(`  ${stats.unverified} launch(es) left unverified (outcome unknown — counted as neither)`);
  // Wording corrected 2026-08-26 (task #1904): this bucket used to be
  // exclusively "the launch is older than the ledger", and on the real ledger
  // it read 0. It now also holds deaths on a RECYCLED workspace ref whose
  // current occupant has no launch row of its own — 18 of them at the time of
  // writing, every one recycled and none pre-ledger. Calling all of them
  // "predates this ledger" would send whoever reads this number looking for a
  // rotation problem that isn't there.
  if (stats.unattributedDeadCount) console.log(`  ${stats.unattributedDeadCount} death(s) not attributable to any launch in this ledger — recycled workspace refs, or a launch older than the ledger (excluded from the rate)`);

  console.log('\n  Per day:');
  for (const d of stats.perDay) {
    const p = d.launches ? ((d.dead / d.launches) * 100).toFixed(0) : '0';
    const bar = '█'.repeat(d.dead);
    console.log(`    ${d.day}  ${String(d.launches).padStart(3)} launches  ${String(d.dead).padStart(2)} dead  ${p.padStart(3)}%  ${bar}`);
  }

  console.log('\n  By lane (all lanes, same window):');
  for (const [name, v] of Object.entries(stats.byLane)) {
    const p = v.launches ? ((v.dead / v.launches) * 100).toFixed(0) : '0';
    console.log(`    ${name.padEnd(20)} ${String(v.launches).padStart(3)} launches  ${String(v.dead).padStart(2)} dead  ${p.padStart(3)}%${v.unverified ? `  (${v.unverified} unverified)` : ''}`);
  }

  if (stats.deadTaskIds.length) {
    console.log(`\n  Tasks with a dead attempt (${stats.deadTaskIds.length}): ${stats.deadTaskIds.join(', ')}`);
  }
  if (stats.unverifiedTaskIds.length) {
    console.log(`  Tasks with an unverified attempt (${stats.unverifiedTaskIds.length}): ${stats.unverifiedTaskIds.join(', ')}`);
  }

  console.log(`\n  ${row.message}\n`);
}

if (require.main === module) main();
