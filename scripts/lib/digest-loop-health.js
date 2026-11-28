'use strict';

const path = require('path');
const { DIGEST_LEDGER_PATH, reconcileDigestOutcomes } = require('./digest-autofix.js');
const dispatchLedger = require('./dispatch-ledger.js');
const { assessAutofixEffectiveness, readLedgerRows } = require('./autofix-effectiveness.js');
const { assessThroughputRow, throughputDeathMessage } = require('./autofix-canary.js');

const BACKLOG_LEDGER_PATH = path.resolve(__dirname, '../../data/audit/backlog-drain-ledger.jsonl');

// The dispatch host reads live ledgers. The committed digest ledger can lag
// that host, so callers on CI must opt out of this local verdict.
function localLoopDeadMessage({
  pendingIssues = 0, pipelineIssues = null, skipMacLocal = false,
  ledgerPath = DIGEST_LEDGER_PATH, backlogLedgerPath = BACKLOG_LEDGER_PATH,
  now = new Date(),
  loadTasksFn = () => { const bn = require('../bsc-next.js'); return bn.loadTasks(bn.TASKS_DIR); },
  dispatchLedgerEntriesFn = () => dispatchLedger.readEntries(),
} = {}) {
  if (skipMacLocal) return null;
  let rows = null;
  try {
    rows = readLedgerRows(ledgerPath);
    if (rows !== null) {
      // runAutofix can return before reconciliation (empty plan, preview or
      // busy lock). Judge a reconciled snapshot regardless. No append or lock
      // is needed here: rendering must also be safe during a dry run.
      const tasksById = new Map(loadTasksFn().map(t => [String(t.id), t]));
      rows = rows.concat(reconcileDigestOutcomes(rows, tasksById, dispatchLedgerEntriesFn(), now));
    }
  } catch (err) {
    console.error(`[digest] WARN could not read/reconcile local autofix ledger: ${String(err.message).slice(0, 120)}`);
    rows = null; // Unknown, never judge an unreconciled snapshot as stalled.
    if (pipelineIssues === null) return null;
  }
  if (rows === null && pipelineIssues === null) return null;
  if (rows !== null) {
    const r = assessAutofixEffectiveness(rows, { now: now.getTime() });
    if (r.status === 'error') return r.message;
  }

  // Keep the zero-dispatch alarm: effectiveness alone cannot detect a loop
  // that stopped launching jobs. The zero-pass arm is already judged above.
  let backlogRows = null;
  try {
    backlogRows = readLedgerRows(backlogLedgerPath);
  } catch (err) {
    console.error(`[digest] WARN could not read backlog-drain ledger: ${String(err.message).slice(0, 120)}`);
  }
  const t = assessThroughputRow({ digestLedgerEntries: rows, backlogLedgerEntries: backlogRows, linearIssues: pipelineIssues, now });
  return throughputDeathMessage(t, { pendingIssues });
}

module.exports = { localLoopDeadMessage };
