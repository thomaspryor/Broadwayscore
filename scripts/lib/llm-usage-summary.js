/**
 * Pure rollup of data/audit/gemini-usage-ledger.jsonl rows (BRO-5043): LLM
 * API spend by provider and by caller. Used by scripts/gemini-usage-summary.js
 * (CLI) and the morning digest's provider-spend snapshot. Estimates from
 * list prices, not invoices; record only. Grounding is priced as an upper
 * bound (the free daily tier is not subtracted).
 */
'use strict';

const fs = require('fs');
const { LEDGER_PATH, TRACKED_SESSION_LEDGER_PATH, sessionLedgerPath, normalizeLegacySessionRow } = require('./gemini-usage-ledger');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** Tracked ledger plus this machine's session-call rows (BRO-7521, kind 'session'). */
function readRows(p) {
  // An explicit path (tests, one-off audits) reads exactly that file; only the
  // default view adds this machine's session rows.
  if (p) return readFile(p);
  const base = process.env.GEMINI_USAGE_LEDGER_PATH || LEDGER_PATH;
  // Committed session rows (BRO-8108) plus this machine's own, each file once. A row folded
  // into the tracked file at wrap-up stays in the Mac's home file too: count it once.
  const home = sessionLedgerPath();
  const isHome = home !== base && home !== TRACKED_SESSION_LEDGER_PATH;
  return mergeLedgerRows({ base: readFile(base), tracked: base === TRACKED_SESSION_LEDGER_PATH ? [] : readFile(TRACKED_SESSION_LEDGER_PATH), home: isHome ? readFile(home) : [] });
}

/**
 * BRO-8356: the tracked session ledger can hold a folded session copy of a legacy reviewer
 * 'api' row the Mac home file still has. Normalize ONLY the home rows (never the CI ledger),
 * then dedupe, so the pair counts once. Pure.
 */
function mergeLedgerRows({ base = [], tracked = [], home = [] }) {
  return mergeRowSets([base, tracked, home.map(normalizeLegacySessionRow)]);
}

/**
 * Concatenate ledgers, keeping each identical session row once (BRO-8108: wrap-up folds home
 * rows into the tracked file, the Mac home keeps them, and two branches can union-merge the
 * same fold). Non-session rows are never dropped: two identical API rows are two real flushes. Pure.
 */
function mergeRowSets(lists) {
  const seen = new Set();
  const out = [];
  for (const rows of lists) for (const r of rows) {
    if (r && r.kind === 'session') {
      const k = JSON.stringify(r);
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(r);
  }
  return out;
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
      a.usd += r.auth === 'oauth' ? 0 : (r.costUsd || 0); // subscription logins are not billed per call (BRO-7596)
      a.calls += r.calls || 0;
      a.unknownCalls += r.unknownCalls || 0;
      a.groundedCalls += r.groundedCalls || 0;
      a.dupCalls += r.dupCalls || 0;
    };
    add(providers[provider] || (providers[provider] = blank()));
    const kind = r.kind || 'api';
    const key = `${provider}|${r.workflow || 'unknown'}|${r.script || 'unknown'}|${kind}`;
    if (!callers.has(key)) callers.set(key, { provider, workflow: r.workflow || 'unknown', script: r.script || 'unknown', kind, ...blank() });
    add(callers.get(key));
  }
  return { providers, callers: [...callers.values()].sort((a, b) => b.usd - a.usd) };
}

const PROVIDER_LABEL = { openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Claude' };
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
    return `${PROVIDER_LABEL[p] || p} est ${money(a.usd)} (${a.calls} calls${extra ? `; ${extra}` : ''})`;
  });
  const topText = s.callers.slice(0, top).filter((c) => c.usd > 0).map((c) => `${c.script} [${c.workflow}] ${money(c.usd)}`).join('; ');
  return `${day} · LLM APIs (metered estimate, not the full bill): ${parts.join(' · ')}${topText ? ` · top: ${topText}` : ''}`;
}

module.exports = {
  mergeLedgerRows, readRows, mergeRowSets, summarize, digestTitle };
