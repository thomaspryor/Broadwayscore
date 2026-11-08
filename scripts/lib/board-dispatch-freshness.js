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
 * plus GitHub schedule lag of 6-13h and late redispatches). Thresholds match
 * the repo's DAILY ledger band in audit-freshness-checks.js (warn 48h, error
 * 96h), so a healthy but late night never files a card.
 *
 * A run that wrote an error row warns only when the last TWO scheduled rows
 * both failed: one transient Linear 5xx is noise for a report-only job.
 *
 * Kill switch: BOARD_DISPATCH_DISABLED=true (same repo variable the job reads)
 * turns the row into a pass that says it is disabled, so switching the
 * dispatcher off on purpose does not page.
 */

const { hoursAgo } = require('./hours-ago');
const h = (n) => `${Math.round(n)}h`;

const BOARD_DISPATCH_FRESHNESS_ROW = 'Freshness: board-dispatch ledger';
const WARN_H = 48;
const ERROR_H = 96;
// The job lands 2026-11-08 or 09; health-check runs before it in the same nightly
// run, so the first night has no ledger yet. Until this instant a missing
// ledger (or no ci row) passes; after it, it is an error, so a job that never
// runs cannot stay quiet.
const FIRST_ROW_DUE = '2026-11-12T18:00:00Z';
const HINT = 'Check the board-dispatch job in data-health-check.yml ("Board dispatch report (report-only)" and "Commit board dispatch ledger", both continue-on-error); kill switch: repo var BOARD_DISPATCH_DISABLED. Rows with source "local" (hand runs) do not count.';

/** Last `n` rows of a JSONL ledger whose source is 'ci', newest first. Bad lines are skipped. */
function lastCiRows(text, n) {
  const out = [];
  if (!text) return out;
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && row.source === 'ci') out.push(row);
  }
  return out;
}

/** Last row of a JSONL ledger whose source is 'ci'. */
function lastCiRow(text) {
  return lastCiRows(text, 1)[0] || null;
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
  const [row, prev] = lastCiRows(ledgerText, 2);
  if (!row) return noRow(name, nowMs, 'Board-dispatch ledger has no scheduled (source "ci") row yet');
  const age = hoursAgo(row.ts, nowMs);
  if (age === Infinity) return { name, status: 'error', message: `Last scheduled row has an unparseable ts: ${String(row.ts).slice(0, 40)}`, hint: HINT };
  if (age > ERROR_H) return { name, status: 'error', message: `Last scheduled board-dispatch row is ${h(age)} old (error threshold: ${h(ERROR_H)})`, hint: HINT };
  if (age > WARN_H) return { name, status: 'warn', message: `Last scheduled board-dispatch row is ${h(age)} old (warn threshold: ${h(WARN_H)})`, hint: HINT };
  if (row.error && prev && prev.error) return { name, status: 'warn', message: `Last two scheduled board-dispatch runs failed: ${String(row.error).slice(0, 120)}`, hint: HINT };
  if (row.error) return { name, status: 'pass', message: `last scheduled row ${h(age)} old; that run failed once (${String(row.error).slice(0, 80)}), warns if the next one fails too` };
  return { name, status: 'pass', message: `last scheduled row ${h(age)} old` };
}

module.exports = { BOARD_DISPATCH_FRESHNESS_ROW, WARN_H, ERROR_H, FIRST_ROW_DUE, lastCiRow, lastCiRows, evaluateBoardDispatchFreshness };
