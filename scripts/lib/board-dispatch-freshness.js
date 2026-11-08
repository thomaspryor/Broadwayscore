/**
 * Freshness alarm for data/audit/board-dispatch.jsonl (BRO-7139).
 *
 * The nightly board-dispatch job in data-health-check.yml appends one row per
 * run. The job is continue-on-error (report-only, CLAUDE.md §19), so a stopped
 * dispatcher never turns a run red: this alarm is the only thing that notices.
 *
 * Only rows with source === 'ci' count. A hand run (`--write` / `--ledger`
 * from a session) stamps source 'local' and must not hide a dead cron.
 *
 * The health-check job runs BEFORE board-dispatch in the same nightly
 * workflow, so on a healthy night it reads the previous night's row (~24h old
 * plus GitHub schedule lag). warn at 36h = one missed night; error at 60h.
 *
 * Kill switch: BOARD_DISPATCH_DISABLED=true (same repo variable the job reads)
 * turns the row into a pass that says it is disabled, so switching the
 * dispatcher off on purpose does not page.
 */

const { hoursAgo, formatAge } = require('./hours-ago');

const BOARD_DISPATCH_FRESHNESS_ROW = 'Freshness: board-dispatch ledger';
const WARN_H = 36;
const ERROR_H = 60;
// The job lands 2026-11-08; health-check runs before it in the same nightly
// run, so the first night has no ledger yet. Until this instant a missing
// ledger (or no ci row) passes; after it, it is an error, so a job that never
// runs cannot stay quiet.
const FIRST_ROW_DUE = '2026-11-10T12:00:00Z';
const HINT = 'Check the board-dispatch job in data-health-check.yml ("Board dispatch report (report-only)" and "Commit board dispatch ledger", both continue-on-error); kill switch: repo var BOARD_DISPATCH_DISABLED. Rows with source "local" (hand runs) do not count.';

/** Last row of a JSONL ledger whose source is 'ci'. Bad lines are skipped. */
function lastCiRow(text) {
  if (!text) return null;
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && row.source === 'ci') return row;
  }
  return null;
}

function noRow(name, nowMs, what) {
  if (nowMs < Date.parse(FIRST_ROW_DUE)) return { name, status: 'pass', message: `${what}; first nightly row due by ${FIRST_ROW_DUE}` };
  return { name, status: 'error', message: `${what}, and the first nightly row was due by ${FIRST_ROW_DUE}`, hint: HINT };
}

/**
 * @param {{ledgerText: string|null, nowMs: number, disabled?: boolean}} input
 *   ledgerText null = file missing.
 * @returns {{name: string, status: 'pass'|'warn'|'error', message: string, hint?: string}}
 */
function evaluateBoardDispatchFreshness({ ledgerText, nowMs, disabled = false }) {
  const name = BOARD_DISPATCH_FRESHNESS_ROW;
  if (disabled) return { name, status: 'pass', message: 'Board dispatch is switched off (BOARD_DISPATCH_DISABLED=true); not checked' };
  if (ledgerText === null || ledgerText === undefined) {
    return noRow(name, nowMs, 'No board-dispatch ledger yet (the nightly job has not written one)');
  }
  const row = lastCiRow(ledgerText);
  if (!row) return noRow(name, nowMs, 'Board-dispatch ledger has no scheduled (source "ci") row yet');
  const age = hoursAgo(row.ts, nowMs);
  if (age === Infinity) return { name, status: 'error', message: `Last scheduled row has an unparseable ts: ${String(row.ts).slice(0, 40)}`, hint: HINT };
  if (age > ERROR_H) return { name, status: 'error', message: `Last scheduled board-dispatch row is ${formatAge(age)} old (error threshold: ${formatAge(ERROR_H)})`, hint: HINT };
  if (age > WARN_H) return { name, status: 'warn', message: `Last scheduled board-dispatch row is ${formatAge(age)} old (warn threshold: ${formatAge(WARN_H)})`, hint: HINT };
  if (row.error) return { name, status: 'warn', message: `Last scheduled board-dispatch run failed: ${String(row.error || 'no detail').slice(0, 120)}`, hint: HINT };
  return { name, status: 'pass', message: `${formatAge(age)} old` };
}

module.exports = { BOARD_DISPATCH_FRESHNESS_ROW, WARN_H, ERROR_H, FIRST_ROW_DUE, lastCiRow, evaluateBoardDispatchFreshness };
