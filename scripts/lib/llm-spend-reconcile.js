/**
 * Monthly reconciliation of the LLM usage ledger against vendor receipts
 * (BRO-7521). Pure. The ledger is an estimate from list prices, so a large
 * shortfall means calls we cannot see (the BRO-7517 gap: ledger $145 vs
 * $580 OpenAI + $900 Google bills), not a rounding difference.
 *
 *   receipts: { "2026-10": { openai: {usd: 580, source: "invoice"}, ... } }
 */
'use strict';

const GAP_THRESHOLD = 0.2;

/** Ledger USD by provider for one UTC month ("YYYY-MM"). Unknown-cost rows add 0. */
function ledgerTotalsForMonth(rows, month) {
  const out = {};
  for (const r of rows || []) {
    if (!r || typeof r.ts !== 'string' || !r.ts.startsWith(month)) continue;
    const p = r.provider || 'gemini';
    const t = out[p] || (out[p] = { usd: 0, calls: 0, unpricedCalls: 0 });
    t.usd += Number.isFinite(r.costUsd) ? r.costUsd : 0;
    t.calls += r.calls || 0;
    // A null cost (unknown model or tokens) adds $0 above; count the calls so an undercount is visible.
    t.unpricedCalls += Number.isFinite(r.costUsd) ? (r.unknownCalls || 0) : (r.calls || 0);
  }
  return out;
}

/**
 * -> { month, lines, flagged, missingReceipts }. A provider is flagged when
 * |receipt - ledger| / receipt exceeds threshold.
 */
function reconcile({ rows, receipts, month, threshold = GAP_THRESHOLD }) {
  const ledger = ledgerTotalsForMonth(rows, month);
  const rec = (receipts && receipts[month]) || {};
  const lines = [];
  const flagged = [];
  const missingReceipts = [];
  const providers = new Set([...Object.keys(ledger), ...Object.keys(rec).filter((k) => !k.startsWith('_'))]);
  for (const p of [...providers].sort()) {
    const l = ledger[p] ? ledger[p].usd : 0;
    const r = rec[p] && Number.isFinite(rec[p].usd) ? rec[p].usd : null;
    if (r === null) {
      missingReceipts.push(p);
      lines.push(`${month} ${p}: ledger $${l.toFixed(2)}, no receipt recorded`);
      continue;
    }
    const gap = r > 0 ? (r - l) / r : (l > 0 ? 1 : 0);
    const pct = Math.round(gap * 100);
    const bad = Math.abs(gap) > threshold;
    const unpriced = ledger[p] && ledger[p].unpricedCalls ? `, ${ledger[p].unpricedCalls} unpriced calls` : '';
    if (bad) flagged.push(p);
    lines.push(`${month} ${p}: ledger $${l.toFixed(2)} vs receipt $${r.toFixed(2)} (${pct >= 0 ? `${pct}% unexplained` : `${-pct}% over-reported`}${unpriced})${bad ? ` GAP over ${Math.round(threshold * 100)}%` : ' ok'}`);
  }
  return { month, lines, flagged, missingReceipts };
}

/** Previous complete UTC month relative to `now`, "YYYY-MM". */
function previousMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

module.exports = { ledgerTotalsForMonth, reconcile, previousMonth, GAP_THRESHOLD };
