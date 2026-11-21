'use strict';
/**
 * BRO-7247 job 3: did the opening-night lane spend anything on paid scrapers inside a time window?
 *
 * Read-only over data/audit/scraper-spend-ledger.jsonl. The earlier-start (cheap pre-embargo) mode is only allowed to
 * ship if this reports zero paid calls for the pre-embargo window of a night it ran.
 */
const fs = require('fs');

const LANE_WORKFLOW_RE = /^Opening-night lane \(live\)$/;

/** A ledger row that cost money: a lane row with credits > 0, or a successful call. Run-memo skips and zero-credit failures are free. */
function isPaidCall(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.fn === 'run-memo-skip') return false;
  if (!LANE_WORKFLOW_RE.test(String(row.workflow || ''))) return false;
  return Number(row.credits) > 0;
}

/** Parse JSONL text, skipping blank/corrupt lines. */
function parseLedger(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a half-written last line */ }
  }
  return rows;
}

/**
 * @param {object[]} rows ledger rows
 * @param {{from: string|number|Date, to: string|number|Date, showId?: string}} win half-open [from, to)
 * @returns {{paid: object[], credits: number, byProvider: Object<string, number>}}
 */
function paidCallsInWindow(rows, { from, to, showId } = {}) {
  const f = new Date(from).getTime(); const t = new Date(to).getTime();
  if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) throw new Error('paidCallsInWindow: from and to must be dates with to > from');
  const paid = (rows || []).filter((r) => {
    if (!isPaidCall(r)) return false;
    if (showId && r.showId !== showId) return false;
    const at = new Date(r.ts).getTime();
    return Number.isFinite(at) && at >= f && at < t;
  });
  const byProvider = {};
  let credits = 0;
  for (const r of paid) { credits += Number(r.credits); byProvider[r.provider] = (byProvider[r.provider] || 0) + Number(r.credits); }
  return { paid, credits, byProvider };
}

function readLedgerFile(file) { return parseLedger(fs.readFileSync(file, 'utf8')); }

module.exports = { LANE_WORKFLOW_RE, isPaidCall, parseLedger, paidCallsInWindow, readLedgerFile };
