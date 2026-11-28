#!/usr/bin/env node
/**
 * audit-false-dead-ledger-rows.js — count `dead` rows in
 * data/audit/dispatch-ledger.jsonl that are CONTRADICTED by the worker's own
 * session report landing on the same Linear issue AFTER the row was written
 * (BRO-2575).
 *
 * A `dead` row is bsc-prune's (or checkDeadDispatch's) verdict that a
 * dispatched workspace died mid-task. deadAttemptsForTask() counts those rows
 * raw, so a false one burns an issue's retry budget, can park it for the owner
 * with no real failure behind it, and — before BRO-2543's reportedOutcomeGuard
 * — could trigger a wasted re-dispatch. The contradiction this script looks for
 * is unambiguous: the SAME issue carries a `**Session report (...)**` comment
 * (the one format `linear-session.js report` writes) timestamped after the
 * `dead` row. A worker that reports back cannot have died before it reported.
 *
 * ATTRIBUTION: delegated to scripts/lib/contradicted-dead-rows.js (BRO-2648),
 * the same function the live dispatch gate uses — see its header. In short:
 * the buried worker's own report must land after the `dead` row and before
 * both the next `launch` and the next "Dispatched ..." comment; automation
 * reports are ignored; anything else after a successor could have started is
 * `ambiguous`, never folded into the headline count.
 *
 * Usage:
 *   node scripts/audit-false-dead-ledger-rows.js [--since=YYYY-MM-DD] [--json]
 *
 * Read-only: fetches from Linear, writes nothing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { classifyDeadRowsForTask } = require('./lib/contradicted-dead-rows.js');
const linear = require('./lib/linear-client.js');
const { dispatchCapDecision } = require('./lib/dispatch-ledger.js');

const LEDGER = process.env.DISPATCH_LEDGER_PATH
  || path.join(__dirname, '..', 'data', 'audit', 'dispatch-ledger.jsonl');

function readLedger(ledgerPath) {
  const rows = [];
  const text = fs.readFileSync(ledgerPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* skip torn line */ }
  }
  return rows;
}

// Only Linear-tracked dispatches can be cross-checked against a Linear comment
// thread; Notion-era numeric taskIds have no thread to read.
function linearIdentifier(row) {
  const id = String((row && row.taskId) || '');
  return /^linear:/.test(id) ? id.replace(/^linear:/, '') : null;
}

function readDeadRows(ledgerPath) {
  return readLedger(ledgerPath)
    .filter(e => e.event === 'dead' && linearIdentifier(e))
    .map(e => ({ ...e, identifier: linearIdentifier(e) }));
}

function toRecord(identifier, r) {
  return {
    identifier,
    workspaceRef: r.workspaceRef,
    deadAt: r.deadAt,
    reportedAt: r.reportedAt,
    reportStatus: r.reportStatus,
    gapMinutes: Math.round((Date.parse(r.reportedAt) - Date.parse(r.deadAt)) / 60000),
    nextLaunchAt: r.nextLaunchAt,
    nextDispatchCommentAt: r.nextDispatchCommentAt,
  };
}

const COMMENTS_QUERY = `query($id: String!) {
  issue(id: $id) {
    identifier
    comments(first: 100, orderBy: createdAt) { nodes { createdAt body } }
  }
}`;

async function main() {
  const args = process.argv.slice(2);
  const sinceArg = (args.find(a => a.startsWith('--since=')) || '').split('=')[1] || null;
  const asJson = args.includes('--json');

  const allRows = readLedger(LEDGER);
  let dead = readDeadRows(LEDGER);
  if (sinceArg) dead = dead.filter(d => String(d.ts || '') >= sinceArg);
  const identifiers = [...new Set(dead.map(d => d.identifier))];

  if (!asJson) {
    console.log(`Ledger: ${LEDGER}`);
    console.log(`Linear-tracked 'dead' rows${sinceArg ? ` since ${sinceArg}` : ''}: ${dead.length} across ${identifiers.length} issue(s)`);
    console.log('Fetching comment threads from Linear…');
  }

  // One request per issue. Sequential on purpose: linear-client.js's graphql()
  // owns the retry/backoff policy and the backlog here is ~dozens of issues,
  // not thousands — parallel bursts would just trip Linear's rate limiter.
  const reportsByIssue = new Map();
  const failed = [];
  for (const id of identifiers) {
    try {
      const data = await linear.graphql(COMMENTS_QUERY, { id });
      const nodes = (data && data.issue && data.issue.comments && data.issue.comments.nodes) || [];
      reportsByIssue.set(id, nodes);
    } catch (e) {
      failed.push({ id, error: e.message });
      reportsByIssue.set(id, null); // unknown, never counted as contradicted
    }
  }

  // BRO-2648: attribution is the shared contradicted-dead-rows.js logic the
  // LIVE dispatch gate uses, so capImpact below is exactly what linear-next
  // now does. Deliberately stricter than this script's original BRO-2575
  // rule: automation-posted reports (zombie sweep, watchdog park) are
  // ignored, and a "Dispatched ..." comment between the death and the report
  // also makes the row ambiguous — so counts are expected to drop.
  const contradicted = [];
  const ambiguous = [];
  for (const id of identifiers) {
    const comments = reportsByIssue.get(id);
    if (!comments) continue; // fetch failed → unknown, not evidence either way
    const taskId = `linear:${id}`;
    // Only rows that passed the --since filter are reported; the full ledger
    // is still passed so next-launch bounds see every launch.
    const inScope = new Set(dead.filter(d => d.identifier === id).map(d => `${d.workspaceRef}|${d.ts}`));
    const { contradicted: c, ambiguous: a } = classifyDeadRowsForTask(taskId, allRows, comments);
    for (const r of c) if (inScope.has(r.key)) contradicted.push(toRecord(id, r));
    for (const r of a) if (inScope.has(r.key)) ambiguous.push(toRecord(id, r));
  }

  // BRO-2599: does discounting this issue's contradicted row(s) actually
  // change dispatchCapDecision's verdict? classifyDeadAttemptsForTask/
  // dispatchCapDecision (BRO-2599) take an opts.contradictedDeadKeys Set of
  // `${workspaceRef}|${ts}` — built here from `contradicted`, the exact rows
  // this run just proved false via the worker's own later session report.
  // Never sourced from `ambiguous` — a re-dispatch intervened there, so the
  // report may belong to the successor, not the buried worker.
  const contradictedByIssue = new Map();
  for (const c of contradicted) {
    if (!contradictedByIssue.has(c.identifier)) contradictedByIssue.set(c.identifier, new Set());
    contradictedByIssue.get(c.identifier).add(`${c.workspaceRef}|${c.deadAt}`);
  }
  const capImpact = [...contradictedByIssue.entries()].map(([identifier, keys]) => {
    const taskId = `linear:${identifier}`;
    const before = dispatchCapDecision(taskId, allRows);
    const after = dispatchCapDecision(taskId, allRows, { contradictedDeadKeys: keys });
    return {
      identifier,
      wasBlocked: before.blocked,
      nowBlocked: after.blocked,
      unblocked: before.blocked && !after.blocked,
      substantiveBefore: before.substantive.length,
      substantiveAfter: after.substantive.length,
    };
  }).sort((a, b) => a.identifier.localeCompare(b.identifier));

  const checkable = dead.filter(d => reportsByIssue.get(d.identifier)).length;
  const result = {
    ledger: LEDGER,
    since: sinceArg,
    deadRows: dead.length,
    issues: identifiers.length,
    fetchFailures: failed,
    checkableRows: checkable,
    contradictedRows: contradicted.length,
    contradictedIssues: new Set(contradicted.map(c => c.identifier)).size,
    ambiguousRows: ambiguous.length,
    contradicted: contradicted.sort((a, b) => a.deadAt.localeCompare(b.deadAt)),
    ambiguous: ambiguous.sort((a, b) => a.deadAt.localeCompare(b.deadAt)),
    capImpact,
  };

  if (asJson) {
    console.log(JSON.stringify({ ...result, contradictedIssues: result.contradictedIssues }, null, 2));
    return;
  }

  if (failed.length) {
    console.log(`\n⚠ ${failed.length} issue(s) could not be fetched (counted as UNKNOWN, never as contradicted):`);
    failed.forEach(f => console.log(`  ${f.id}: ${f.error}`));
  }
  console.log(`\nCheckable 'dead' rows: ${checkable}`);
  console.log(`CONTRADICTED — the buried worker itself reported back afterwards: ${contradicted.length} row(s) across ${result.contradictedIssues} issue(s)`);
  if (contradicted.length) {
    const pct = ((contradicted.length / checkable) * 100).toFixed(1);
    console.log(`False-dead rate: ${pct}% of checkable rows\n`);
    for (const c of result.contradicted) {
      console.log(`  ${c.identifier.padEnd(9)} ${(c.workspaceRef || '?').padEnd(13)} dead ${c.deadAt}  →  reported (${c.reportStatus}) ${c.reportedAt}  (+${c.gapMinutes} min)`);
    }
  }
  if (ambiguous.length) {
    console.log(`\nAMBIGUOUS (a re-dispatch landed before the report — report may be the successor's, NOT counted above): ${ambiguous.length} row(s)`);
    for (const c of result.ambiguous) {
      console.log(`  ${c.identifier.padEnd(9)} ${(c.workspaceRef || '?').padEnd(13)} dead ${c.deadAt}  →  relaunched ${c.nextLaunchAt}  →  reported ${c.reportedAt}`);
    }
  }
  if (capImpact.length) {
    const unblocked = capImpact.filter(c => c.unblocked);
    console.log(`\nDISPATCH CAP IMPACT — discounting each issue's own contradicted row(s) in dispatchCapDecision:`);
    for (const c of capImpact) {
      const verdict = c.unblocked ? 'UNBLOCKS' : c.wasBlocked ? 'still blocked' : 'was not blocked';
      console.log(`  ${c.identifier.padEnd(9)} substantive ${c.substantiveBefore} → ${c.substantiveAfter}  (${verdict})`);
    }
    console.log(`\n${unblocked.length} issue(s) unblock once their proven-false row(s) are discounted: ${unblocked.map(c => c.identifier).join(', ') || 'none'}`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { readDeadRows };
