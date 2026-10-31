/**
 * gemini-usage-ledger.js: record Gemini API usage per workflow (BRO-5043).
 *
 * Record only. Nothing here blocks, caps or alters a call: the owner declined
 * caps (BRO-3028); this exists so the Google Cloud bill can be explained.
 *
 * install() wraps global fetch once and observes responses from
 * generativelanguage.googleapis.com (response.clone(), the caller's response is
 * never touched). Calls are aggregated in memory per (model) and flushed as ONE
 * row per model at process exit, so ~100 callers do not write thousands of
 * lines a day. Rows go to data/audit/gemini-usage-ledger.jsonl (merge=union,
 * committed by the commit-scraper-spend-ledger composite action). Prints
 * nothing (callers parse stdout) and never records the URL (it carries ?key=).
 * Coverage: processes that load a shared Gemini lib or call install(); batch
 * operations are not observed here (usage sits per entry in the operation).
 *
 * A response without usageMetadata counts the call but leaves tokens unknown
 * (null), never zero: zero would read as "free".
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isTestRun } = require('./test-run-guard');

const LEDGER_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'gemini-usage-ledger.jsonl');
const GEMINI_HOST = 'generativelanguage.googleapis.com';

// USD per 1M tokens (input, output). Published list prices, standard tier;
// an estimate for attribution, not an invoice. Unknown model -> cost null.
const PRICES_PER_M = [
  [/gemini-2\.5-pro/, [1.25, 10]],
  [/gemini-2\.5-flash-lite/, [0.10, 0.40]],
  [/gemini-2\.5-flash/, [0.30, 2.50]],
];

function extractUsage(json) {
  const u = json && json.usageMetadata;
  if (!u || typeof u !== 'object') return null;
  const inTok = Number.isFinite(u.promptTokenCount) ? u.promptTokenCount : null;
  const cand = Number.isFinite(u.candidatesTokenCount) ? u.candidatesTokenCount : 0;
  const thoughts = Number.isFinite(u.thoughtsTokenCount) ? u.thoughtsTokenCount : 0;
  if (inTok === null && !Number.isFinite(u.candidatesTokenCount)) return null;
  // Thinking tokens bill as output.
  return { inputTokens: inTok, outputTokens: cand + thoughts };
}

function estimateCostUsd(model, inputTokens, outputTokens) {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const hit = PRICES_PER_M.find(([re]) => re.test(String(model || '')));
  if (!hit) return null;
  const [pin, pout] = hit[1];
  return +((inputTokens * pin + outputTokens * pout) / 1e6).toFixed(6);
}

function modelFromUrl(url) {
  const m = String(url || '').match(/\/models\/([^:/?]+)/);
  return m ? m[1] : 'unknown';
}

const _agg = new Map(); // model -> { calls, unknownCalls, inputTokens, outputTokens }

/** Add one call. usage is extractUsage()'s result or null (unknown). Never throws. */
function recordGeminiUsage({ model, usage }) {
  try {
    const key = model || 'unknown';
    const a = _agg.get(key) || { calls: 0, unknownCalls: 0, inputTokens: 0, outputTokens: 0 };
    a.calls += 1;
    if (!usage || usage.inputTokens === null) a.unknownCalls += 1;
    else { a.inputTokens += usage.inputTokens; a.outputTokens += usage.outputTokens; }
    _agg.set(key, a);
  } catch { /* record only */ }
}

function _scriptName() {
  try { return process.argv[1] ? path.basename(process.argv[1]) : 'unknown'; } catch { return 'unknown'; }
}

/** Pure: aggregated state -> ledger rows. */
function buildRows(agg, { now = new Date(), workflow, script } = {}) {
  const rows = [];
  for (const [model, a] of agg) {
    const known = a.calls - a.unknownCalls;
    const allUnknown = known === 0;
    rows.push({
      ts: now.toISOString(),
      workflow: workflow || process.env.GITHUB_WORKFLOW || 'local',
      runId: process.env.GITHUB_RUN_ID || null,
      script: script || _scriptName(),
      model,
      calls: a.calls,
      unknownCalls: a.unknownCalls,
      inputTokens: allUnknown ? null : a.inputTokens,
      outputTokens: allUnknown ? null : a.outputTokens,
      costUsd: allUnknown ? null : estimateCostUsd(model, a.inputTokens, a.outputTokens),
    });
  }
  return rows;
}

function _ledgerPath() {
  if (process.env.GEMINI_USAGE_LEDGER_PATH) return process.env.GEMINI_USAGE_LEDGER_PATH;
  // Never write the real ledger from a test process (same rule as provider-telemetry).
  if (isTestRun()) return path.join(os.tmpdir(), `gemini-usage-ledger.test-${process.pid}.jsonl`);
  return LEDGER_PATH;
}

/** Write the aggregated rows and reset. Never throws. */
function flush() {
  try {
    if (process.env.GEMINI_USAGE_DISABLED === '1' || _agg.size === 0) { _agg.clear(); return []; }
    const rows = buildRows(_agg);
    _agg.clear();
    const p = _ledgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return rows;
  } catch { return []; }
}

const INSTALLED = Symbol.for('bsc.geminiUsage');
function install() {
  if (globalThis[INSTALLED] || typeof globalThis.fetch !== 'function') return;
  globalThis[INSTALLED] = true;
  const orig = globalThis.fetch;
  globalThis.fetch = async function geminiObservedFetch(input, init) {
    const res = await orig.apply(this, arguments);
    try {
      let url = '';
      try { url = typeof input === 'string' ? input : (input && (input.url || String(input))) || ''; } catch { /* ignore */ }
      // Only plain non-streaming generateContent; batch and SSE are skipped.
      if (!url.includes(GEMINI_HOST) || !/:generateContent(\?|$)/.test(url)) return res;
      if (!res || !res.ok || typeof res.clone !== 'function') return res;
      const ct = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : 'application/json';
      if (!ct.includes('json')) return res;
      const model = modelFromUrl(url);
      let usage = null;
      try { usage = extractUsage(await res.clone().json()); } catch { /* unknown */ }
      recordGeminiUsage({ model, usage });
    } catch { /* record only */ }
    return res; // the caller always gets the original response
  };
  process.once('exit', flush);
}

module.exports = { extractUsage, estimateCostUsd, modelFromUrl, recordGeminiUsage, buildRows, flush, install, LEDGER_PATH };
