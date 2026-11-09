#!/usr/bin/env node
'use strict';
/**
 * llm-triage-acceptance.js — judges BRO-7139's "Done" bar from committed ledgers only.
 *
 * From the revised plan: done only when the stuck group shrinks for 4 consecutive weekly
 * snapshots, ready >= 10, audit wrong-rate < 5% (over >= 30 distinct judged nominations),
 * and the coverage test is green. Prints one line per criterion; exits 0 only when all pass.
 *
 *   node scripts/llm-triage-acceptance.js
 *
 * "Weekly snapshot" = the newest clean CI v2 row of data/audit/board-dispatch.jsonl in each
 * UTC ISO week. "Shrinks for 4 consecutive" = the last 4 weekly snapshots each strictly
 * below the one before (3 week-over-week drops, 0 -> 0 allowed), with no gap week between
 * them. The wrong-rate counts only CI audits and only informative judgments (see
 * llm-triage-audit.js SCORED).
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Q = require('./lib/llm-triage-queue.js');
const A = require('./lib/llm-triage-audit.js');

const ROOT = path.resolve(__dirname, '..');
const WEEK_MS = 7 * 86400000;
const MIN_READY = 10;
const MIN_JUDGED = 30;
const MAX_WRONG = 0.05;
const WEEKS = 4;

/** Monday 00:00 UTC of the row's week, as ms. */
function weekStart(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

function weeklySnapshots(rows) {
  const byWeek = new Map();
  for (const r of rows || []) {
    if (!r || r.source !== 'ci' || r.error || !(r.v >= 2) || !r.groups) continue;
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t)) continue;
    const w = weekStart(t);
    const prev = byWeek.get(w);
    if (!prev || Date.parse(prev.ts) < t) byWeek.set(w, r);
  }
  return [...byWeek.entries()].sort((a, b) => a[0] - b[0]).map(([week, r]) => ({ week, stuck: Number(r.groups.stuck) || 0, ready: Number(r.ready) || 0, ts: r.ts }));
}

function stuckShrinks(snaps, weeks = WEEKS) {
  const last = snaps.slice(-weeks);
  if (last.length < weeks) return { pass: false, detail: `${snaps.length} weekly snapshot(s), need ${weeks}` };
  for (let i = 1; i < last.length; i++) {
    if (last[i].week - last[i - 1].week !== WEEK_MS) return { pass: false, detail: 'gap week in the last snapshots' };
    // Strictly lower each week; an empty stuck group staying empty also counts.
    if (!(last[i].stuck < last[i - 1].stuck || (last[i].stuck === 0 && last[i - 1].stuck === 0))) return { pass: false, detail: `stuck ${last.map((s) => s.stuck).join(' -> ')}` };
  }
  return { pass: true, detail: `stuck ${last.map((s) => s.stuck).join(' -> ')}` };
}

function judge({ dispatchRows, auditRows, coverageOk }) {
  const snaps = weeklySnapshots(dispatchRows);
  const latest = snaps[snaps.length - 1];
  const cum = A.cumulativeJudgments(auditRows);
  const criteria = [
    { name: 'stuck group shrinks 4 weeks running', ...stuckShrinks(snaps) },
    { name: `ready >= ${MIN_READY}`, pass: !!latest && latest.ready >= MIN_READY, detail: latest ? `ready ${latest.ready} (${latest.ts})` : 'no CI v2 snapshot yet' },
    { name: `audit wrong-rate < ${MAX_WRONG * 100}% over >= ${MIN_JUDGED}`, pass: cum.scored >= MIN_JUDGED && cum.wrongRate < MAX_WRONG,
      detail: `${cum.scored} scored, ${cum.wrong} wrong${cum.wrongRate == null ? '' : ` (${(cum.wrongRate * 100).toFixed(1)}%)`}` },
    { name: 'coverage test green', pass: !!coverageOk, detail: coverageOk ? 'board-handlers + board-dispatch tests pass' : 'tests fail' },
  ];
  return { pass: criteria.every((c) => c.pass), criteria };
}

const readRows = (p) => (fs.existsSync(p) ? Q.parseLedger(fs.readFileSync(p, 'utf8')) : []);

function main({ log = console.log, root = ROOT, runTests = null } = {}) {
  const coverageOk = runTests ? runTests() : spawnSync(process.execPath, ['--test', 'scripts/lib/board-handlers.test.mjs', 'scripts/lib/board-dispatch.test.mjs'], { cwd: root, stdio: 'ignore', timeout: 180000 }).status === 0;
  const res = judge({ dispatchRows: readRows(path.join(root, 'data/audit/board-dispatch.jsonl')), auditRows: readRows(path.join(root, A.AUDIT_LEDGER_PATH)), coverageOk });
  for (const c of res.criteria) log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  log(res.pass ? 'BRO-7139 acceptance: PASS' : 'BRO-7139 acceptance: not yet');
  return res.pass ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { weekStart, weeklySnapshots, stuckShrinks, judge, main };
