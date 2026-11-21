#!/usr/bin/env node
/**
 * board-hygiene-sweep.js (BRO-6857) — prose date-wait stamps, machine audit-log closes and the monthly age sweep.
 *   node scripts/board-hygiene-sweep.js [--prose] [--logs] [--age]   (none = all three) dry run: prints the plan
 *   node scripts/board-hygiene-sweep.js --apply [...]                  writes it through linear-brain.js update
 * `--age --apply` moves VERIFY-bearing Backlog cards to Todo and posts a dated AGE-SWEEP-RECONFIRMED comment on the rest
 * (so each card shows up again after 30 days). It never closes an old card: that is a per-card call. The monthly workflow
 * is report-only and never passes --apply.
 */
'use strict';
require('./lib/cli-help').exitOnHelp(module);
const { spawnSync } = require('child_process');
const path = require('path');
const bc = require('./lib/board-categories.js');
const h = require('./lib/board-hygiene.js');

const LB = path.join(__dirname, 'linear-brain.js');
const update = (id, args) => spawnSync('node', [LB, 'update', id, ...args], { encoding: 'utf8' });

function renderReport({ prose, logs, age }, nowMs) {
  const L = [`# Board hygiene sweep ${new Date(nowMs).toISOString().slice(0, 10)} (dry run)`, ''];
  L.push(`Prose date waits to stamp: ${prose.length}`, ...prose.map((p) => `- ${p.identifier} RECHECK-AFTER ${p.date} (${p.reason})`), '');
  L.push(`Audit logs to close: ${logs.length}`, ...logs.map((p) => `- ${p.identifier} ${p.title}`), '');
  L.push(`Age sweep (created more than ${h.AGE_DAYS} days ago): dispatch ${age.dispatch.length}, needs-VERIFY ${age.needsVerify.length}, reconfirm ${age.reconfirm.length}, skipped ${age.skipped.length}`);
  for (const k of ['dispatch', 'needsVerify', 'reconfirm']) L.push('', `## ${k}`, ...age[k].map((x) => `- ${x.identifier} P${x.priority} ${x.state} ${x.ageDays}d: ${String(x.title).slice(0, 70)} (${x.reason.slice(0, 60)})`));
  return L.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const only = ['--prose', '--logs', '--age'].filter((f) => argv.includes(f));
  const want = (f) => only.length === 0 || only.includes(f);
  const { graphql } = require('./lib/linear-client.js');
  const cards = await bc.fetchOpenBoard({ graphql });
  const nowMs = Date.now();
  const plan = {
    prose: want('--prose') ? h.planProseStamps(cards, nowMs) : [],
    logs: want('--logs') ? h.planMachineLogs(cards) : [],
    age: want('--age') ? h.planAgeSweep(cards, nowMs) : { dispatch: [], needsVerify: [], reconfirm: [], skipped: [] },
  };
  console.log(renderReport(plan, nowMs));
  if (!apply) return;
  let failed = 0;
  const run = (label, id, args) => { const r = update(id, args); console.log(`${r.status === 0 ? 'ok  ' : 'FAIL'} ${label} ${id}`); if (r.status !== 0) { failed++; console.error(String(r.stderr).split('\n')[0]); } };
  for (const p of plan.prose) run('stamp', p.identifier, ['--comment', `RECHECK-AFTER: ${p.date}\nAuto-stamped (BRO-6857): the park reason waits on time written in words ("${p.reason}"), which nothing resumes. The nightly recheck looks again on this date.`]);
  for (const p of plan.logs) run('close', p.identifier, ['--state', 'Canceled', '--cancel-reason', p.reason, '--comment', p.reason]);
  for (const p of plan.age.dispatch) run('todo', p.identifier, ['--state', 'Todo', '--comment', p.reason]);
  const day = new Date(nowMs).toISOString().slice(0, 10);
  for (const p of [...plan.age.needsVerify, ...plan.age.reconfirm]) run('reconfirm', p.identifier, ['--comment', `AGE-SWEEP-RECONFIRMED: ${day}\nOpen ${p.ageDays} days; reconfirmed by the monthly age sweep (BRO-6857). ${p.reason}`]);
  if (failed) process.exit(1);
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { renderReport };
