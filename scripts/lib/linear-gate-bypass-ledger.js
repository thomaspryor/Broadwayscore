/**
 * linear-gate-bypass-ledger.js — append-only record of every time a Done-gate
 * refusal was overridden via --force or LINEAR_DONE_GATE_DISABLED=1.
 *
 * WHY THIS EXISTS (BRO-3435, 2026-09-21). Before this file, `grep -rn
 * 'forceReason|gate-forced|done-gate-force' scripts/` returned nothing —
 * every bypass of linear-done-gate.js's refusal was invisible after the
 * fact. That made a real open question ("is the data-repo evidence gap
 * actually costing anyone anything, i.e. is --force the ROUTINE path for
 * those closes?") permanently unanswerable, which is exactly the trap a
 * second-opinion review flagged: don't build a bigger cross-repo verifier on
 * a premise nobody can measure. This ledger is what turns "unmeasured" into
 * a number a future session (or `scripts/audit-done-evidence.js`) can
 * actually query.
 *
 * Append pattern mirrors import-ledger.js's appendRow: one appendFileSync of
 * one already-newline-terminated JSON string, so concurrent writers on this
 * machine's many parallel sessions interleave whole lines on a local
 * filesystem instead of tearing each other's. See that file's header for the
 * precise atomicity claim (a local-filesystem property, not a Node
 * guarantee) and why a torn line is tolerated rather than fatal.
 *
 * NOT wired to a git checkpoint like import-ledger.js's checkpointLedger —
 * this ledger is small, low-frequency, and diagnostic rather than the
 * single source of truth for a multi-hour migration, so the ordinary commit
 * cadence for data/audit/** is enough.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Anchored to __dirname, NOT process.cwd() (ship-check finding, 2026-09-21,
// confirmed live: this worktree's own cwd-relative write left a stray,
// never-committed data/audit/linear-gate-bypass.jsonl on disk). CLAUDE.md
// requires sessions to work in worktrees, and callers like bsc-prune.js spawn
// linear-brain.js with no explicit cwd — a cwd-relative default fragments the
// ledger across every worktree that ever ran this CLI, most of which are
// deleted after merging and never commit their copy. That defeats the entire
// "turn unmeasured bypass usage into a number" premise this file exists for.
// Matches the sibling precedent (bww-roundup-persistence.js's
// MISS_LEDGER_PATH: path.join(__dirname, '..', '..', 'data', 'audit', ...)).
const DEFAULT_LEDGER = path.join(__dirname, '..', '..', 'data', 'audit', 'linear-gate-bypass.jsonl');

/**
 * @param {object} row
 * @param {string} row.identifier   the BRO-N being moved
 * @param {string} row.gate         which gate was bypassed, e.g. 'done'
 * @param {string} row.mechanism    'force' | 'env-disabled'
 * @param {string} [row.reason]     the --force reason text, when mechanism is 'force'
 * @param {string} [row.targetState] the state name the issue was moved to
 * @param {string} [ledgerPath]     override for tests; defaults to DEFAULT_LEDGER
 */
function appendBypassRow(row, ledgerPath = DEFAULT_LEDGER) {
  const abs = path.resolve(ledgerPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const record = {
    at: new Date().toISOString(),
    identifier: row.identifier || null,
    gate: row.gate || 'done',
    mechanism: row.mechanism,
    reason: row.reason || null,
    targetState: row.targetState || null,
  };
  fs.appendFileSync(abs, `${JSON.stringify(record)}\n`);
  return record;
}

function readBypassRows(ledgerPath = DEFAULT_LEDGER) {
  const abs = path.resolve(ledgerPath);
  if (!fs.existsSync(abs)) return [];
  const rows = [];
  for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Torn line from a kill mid-append — skipped, not fatal (import-ledger.js precedent).
    }
  }
  return rows;
}

module.exports = { DEFAULT_LEDGER, appendBypassRow, readBypassRows };
