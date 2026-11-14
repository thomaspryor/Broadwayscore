/**
 * Pure rollup of data/audit/gemini-usage-ledger.jsonl rows (BRO-5043): LLM
 * API spend by provider and by caller. Used by scripts/gemini-usage-summary.js
 * (CLI) and the morning digest's provider-spend snapshot. Estimates from
 * list prices, not invoices; record only. Grounding is priced as an upper
 * bound (the free daily tier is not subtracted).
 */
'use strict';

const fs = require('fs');
const { LEDGER_PATH } = require('./gemini-usage-ledger');

function readRows(p = process.env.GEMINI_USAGE_LEDGER_PATH || LEDGER_PATH) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** rows -> { providers: {name: totals}, callers: [{provider, workflow, script, ...totals}] } */
function summarize(rows, { fromMs = -Infinity, toMs = Infinity } = {}) {
  const blank = () => ({ usd: 0, calls: 0, unknownCalls: 0, groundedCalls: 0, dupCalls: 0 });
  const providers = {};
  const callers = new Map();
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (!(t >= fromMs && t < toMs)) continue;
    const provider = r.provider || 'gemini'; // rows written before the provider field are all Gemini
    const add = (a) => {
      a.usd += r.costUsd || 0;
      a.calls += r.calls || 0;
      a.unknownCalls += r.unknownCalls || 0;
      a.groundedCalls += r.groundedCalls || 0;
      a.dupCalls += r.dupCalls || 0;
    };
    add(providers[provider] || (providers[provider] = blank()));
    const key = `${provider}|${r.workflow || 'unknown'}|${r.script || 'unknown'}`;
    if (!callers.has(key)) callers.set(key, { provider, workflow: r.workflow || 'unknown', script: r.script || 'unknown', ...blank() });
    add(callers.get(key));
  }
  return { providers, callers: [...callers.values()].sort((a, b) => b.usd - a.usd) };
}

const money = (n) => `$${n.toFixed(2)}`;

/** One digest line for a UTC day (YYYY-MM-DD), or null when nothing was metered. */
function digestTitle(rows, day, { top = 3 } = {}) {
  const from = Date.parse(`${day}T00:00:00Z`);
  const s = summarize(rows, { fromMs: from, toMs: from + 86400000 });
  const names = Object.keys(s.providers).sort();
  if (!names.length) return null;
  const parts = names.map((p) => {
    const a = s.providers[p];
    const extra = [
      a.groundedCalls ? `${a.groundedCalls} search-grounded` : '',
      a.dupCalls ? `${a.dupCalls} repeats` : '',
      a.unknownCalls ? `${a.unknownCalls} unpriced` : '',
    ].filter(Boolean).join(', ');
    return `${p === 'openai' ? 'OpenAI' : 'Gemini'} est ${money(a.usd)} (${a.calls} calls${extra ? `; ${extra}` : ''})`;
  });
  const topText = s.callers.slice(0, top).filter((c) => c.usd > 0).map((c) => `${c.script} [${c.workflow}] ${money(c.usd)}`).join('; ');
  return `${day} · LLM APIs (metered estimate, not the full bill): ${parts.join(' · ')}${topText ? ` · top: ${topText}` : ''}`;
}

module.exports = { readRows, summarize, digestTitle };
