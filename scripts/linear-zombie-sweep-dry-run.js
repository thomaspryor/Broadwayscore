#!/usr/bin/env node
'use strict';
/**
 * linear-zombie-sweep-dry-run.js — print the started-zombie sweep's decision
 * for every candidate card without writing to Linear or the ledger (BRO-4510).
 * It DOES run each card's VERIFY command (read-only, against a fresh
 * origin/main checkout), with no per-tick budget.
 *
 *   node scripts/linear-zombie-sweep-dry-run.js [--only=BRO-1,BRO-2]
 */
const { sweepLinearStartedZombies } = require('./bsc-reconcile.js');
const { findJobDoneLinearCandidates } = require('./lib/linear-started-zombie-sweep.js');
const ledger = require('./lib/dispatch-ledger.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/linear-zombie-sweep-dry-run.js [--only=BRO-1,BRO-2]';

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
  const readLedgerEntriesFn = () => {
    const entries = ledger.readEntries();
    if (!only) return entries;
    const keep = new Set(findJobDoneLinearCandidates(entries).filter((c) => only.has(c.identifier)).map((c) => c.taskId));
    return entries.filter((e) => keep.has(String(e.taskId)));
  };
  const out = await sweepLinearStartedZombies({ dryRun: true, deps: { readLedgerEntriesFn } });
  const rows = [
    ...out.done.map((r) => ['done', r.identifier, r.reason]),
    ...out.todo.map((r) => ['todo', r.identifier, r.reason]),
    ...out.left.map((r) => ['leave', r.identifier, r.reason]),
    ...out.refused.map((r) => ['refuse', r.identifier, r.reason]),
  ];
  for (const [action, id, reason] of rows) console.log(`${id}\t${action}\t${reason}`);
  const tally = rows.reduce((a, [action, , reason]) => { const k = `${action}:${reason}`; a[k] = (a[k] || 0) + 1; return a; }, {});
  console.log(JSON.stringify({ checked: out.checked, tally }));
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
module.exports = { main };
