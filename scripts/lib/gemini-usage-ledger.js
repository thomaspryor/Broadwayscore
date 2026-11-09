/**
 * gemini-usage-ledger.js: record LLM API usage per workflow (BRO-5043).
 * Despite the name it now meters OpenAI too (rows carry `provider`); the
 * file and ledger path keep their names so old rows and callers still work.
 *
 * Record only. Nothing here blocks, caps or alters a call: the owner declined
 * caps (BRO-3028); this exists so the Google Cloud and OpenAI bills can be
 * explained.
 *
 * install() wraps global fetch once and observes responses from
 * generativelanguage.googleapis.com and api.openai.com (response.clone(), the
 * caller's response is never touched). Calls are aggregated in memory per
 * (provider, model) and flushed as ONE row each at process exit, so ~100
 * callers do not write thousands of lines a day. Rows go to
 * data/audit/gemini-usage-ledger.jsonl (merge=union). Prints nothing (callers
 * parse stdout) and never records the URL (Gemini carries ?key=).
 *
 * Coverage: every file that calls Gemini or OpenAI calls install() before it
 * builds a client, enforced by tests/unit/llm-usage-install-coverage.test.mjs.
 * Order matters because the openai SDK captures globalThis.fetch when a client
 * is constructed (openai/client.js `options.fetch ?? getDefaultFetch()`);
 * @google/generative-ai reads the global per request. Batch operations
 * (batchGenerateContent, /v1/batches) are not observed here: the ensemble
 * scorer's batch cost is in data/llm-scoring-runs.json instead.
 *
 * A response without usage counts the call but leaves tokens unknown (null),
 * never zero: zero would read as "free". Streaming (SSE) calls count as
 * unknown for the same reason.
 *
 * Extra counters (owner asked 2026-11-08 to explain and cut the bill):
 *   groundedCalls      Gemini answers that used Google Search grounding
 *                      (billed per prompt above the free daily tier) and
 *                      OpenAI web_search calls. Costed at list price: an
 *                      UPPER bound.
 *   cachedInputTokens  input billed at the cached rate.
 *   dupCalls           requests whose (url minus key, body) repeated an
 *                      earlier one in the same process: what a response
 *                      cache would save.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isTestRun } = require('./test-run-guard');
const { RATES: OPENAI_RATES, WEB_SEARCH_CALL_USD: OPENAI_SEARCH_USD } = require('./research-cost');

const LEDGER_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'gemini-usage-ledger.jsonl');
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const OPENAI_HOST = 'api.openai.com';
const REPO_ROOT = path.join(__dirname, '..', '..');

// Gemini: USD per 1M tokens (input, output). Published list prices, standard
// tier; an estimate for attribution, not an invoice. Cached input bills at a
// quarter of the input rate (Gemini 2.5 context caching). Unknown -> null.
const PRICES_PER_M = [
  [/gemini-2\.5-pro/, [1.25, 10]],
  [/gemini-2\.5-flash-lite/, [0.10, 0.40]],
  [/gemini-2\.5-flash/, [0.30, 2.50]],
  [/gemini-2\.0-flash/, [0.10, 0.40]],
];
const GEMINI_CACHED_FACTOR = 0.25;
// Grounding with Google Search: $35 per 1k grounded prompts above the free
// daily tier. Charged per call here, so it is an upper bound.
const GEMINI_GROUNDED_USD = 0.035;

// OpenAI: research-cost.js RATES is the one price table (BRO-4990); these are
// the non-research models our pipelines call. USD per 1M tokens.
const OPENAI_EXTRA_RATES = {
  'gpt-4o': { input: 2.50, cached: 1.25, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.60 },
  'gpt-4.1': { input: 2.00, cached: 0.50, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, cached: 0.10, output: 1.60 },
  'text-embedding-3-small': { input: 0.02, cached: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, cached: 0.13, output: 0 },
};

const MAX_HASH_BYTES = 256 * 1024;

function openaiRates(model) {
  const m = String(model || '');
  const alias = m.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return OPENAI_RATES[m] || OPENAI_RATES[alias] || OPENAI_EXTRA_RATES[m] || OPENAI_EXTRA_RATES[alias] || null;
}

/** Gemini response JSON -> {inputTokens, outputTokens[, cachedInputTokens]} or null. */
function extractUsage(json) {
  const u = json && json.usageMetadata;
  if (!u || typeof u !== 'object') return null;
  const inTok = Number.isFinite(u.promptTokenCount) ? u.promptTokenCount : null;
  const cand = Number.isFinite(u.candidatesTokenCount) ? u.candidatesTokenCount : 0;
  const thoughts = Number.isFinite(u.thoughtsTokenCount) ? u.thoughtsTokenCount : 0;
  if (inTok === null && !Number.isFinite(u.candidatesTokenCount)) return null;
  // Thinking tokens bill as output. Cached tokens are a subset of the prompt.
  const out = { inputTokens: inTok, outputTokens: cand + thoughts };
  if (Number.isFinite(u.cachedContentTokenCount) && u.cachedContentTokenCount > 0) out.cachedInputTokens = u.cachedContentTokenCount;
  return out;
}

/** Gemini: did this answer use Google Search grounding? */
function geminiGrounded(json) {
  const cands = (json && Array.isArray(json.candidates)) ? json.candidates : [];
  return cands.some((c) => {
    const g = c && c.groundingMetadata;
    return !!(g && ((Array.isArray(g.webSearchQueries) && g.webSearchQueries.length) || g.searchEntryPoint));
  });
}

/** OpenAI response JSON (chat, responses, embeddings) -> usage or null. */
function extractOpenAIUsage(json) {
  const u = json && json.usage;
  if (!u || typeof u !== 'object') return null;
  const input = Number.isFinite(u.input_tokens) ? u.input_tokens : (Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : null);
  if (input === null) return null;
  // completion_tokens / output_tokens already include reasoning tokens.
  const output = Number.isFinite(u.output_tokens) ? u.output_tokens : (Number.isFinite(u.completion_tokens) ? u.completion_tokens : 0);
  const det = u.input_tokens_details || u.prompt_tokens_details || {};
  const out = { inputTokens: input, outputTokens: output };
  if (Number.isFinite(det.cached_tokens) && det.cached_tokens > 0) out.cachedInputTokens = Math.min(input, det.cached_tokens);
  return out;
}

/** OpenAI Responses API: number of web_search tool calls (upper bound). */
function openaiSearchCalls(json) {
  const out = json && Array.isArray(json.output) ? json.output : [];
  return out.filter((i) => i && (i.type === 'web_search_call' || i.type === 'web_search')).length;
}

/**
 * Estimated USD, or null for an unknown model. Old 3-argument calls price
 * Gemini. opts: { provider='gemini', cachedInputTokens=0, groundedCalls=0 }
 */
function estimateCostUsd(model, inputTokens, outputTokens, opts = {}) {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const provider = opts.provider || 'gemini';
  const cached = Math.min(inputTokens, Number(opts.cachedInputTokens) || 0);
  const searches = Number(opts.groundedCalls) || 0;
  let usd;
  if (provider === 'openai') {
    const r = openaiRates(model);
    if (!r) return null;
    usd = ((inputTokens - cached) * r.input + cached * r.cached + outputTokens * r.output) / 1e6 + searches * OPENAI_SEARCH_USD;
  } else {
    const hit = PRICES_PER_M.find(([re]) => re.test(String(model || '')));
    if (!hit) return null;
    const [pin, pout] = hit[1];
    usd = ((inputTokens - cached) * pin + cached * pin * GEMINI_CACHED_FACTOR + outputTokens * pout) / 1e6 + searches * GEMINI_GROUNDED_USD;
  }
  return +usd.toFixed(6);
}

function modelFromUrl(url) {
  const m = String(url || '').match(/\/models\/([^:/?]+)/);
  return m ? m[1] : 'unknown';
}

const _agg = new Map(); // `${provider}|${model}` -> counters
const _seen = new Set(); // request hashes, this process only
const _pending = new Set(); // in-flight body reads

/** Resolves once every in-flight body read has been recorded (tests, explicit flushes). */
function settle() {
  return Promise.all([..._pending]).then(() => undefined);
}

function _counter(key) {
  let a = _agg.get(key);
  if (!a) {
    a = { calls: 0, unknownCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, groundedCalls: 0, dupCalls: 0 };
    _agg.set(key, a);
  }
  return a;
}

/** Add one call. usage is an extract*Usage() result or null (unknown). Never throws. */
function recordUsage({ provider = 'gemini', model, usage, grounded = 0, dup = false }) {
  try {
    const a = _counter(`${provider}|${model || 'unknown'}`);
    a.calls += 1;
    if (dup) a.dupCalls += 1;
    a.groundedCalls += Number(grounded) || 0;
    if (!usage || usage.inputTokens === null) a.unknownCalls += 1;
    else {
      a.inputTokens += usage.inputTokens;
      a.outputTokens += usage.outputTokens;
      a.cachedInputTokens += usage.cachedInputTokens || 0;
    }
  } catch { /* record only */ }
}

/** Back-compat name (Gemini only). */
function recordGeminiUsage({ model, usage }) {
  recordUsage({ provider: 'gemini', model, usage });
}

function _scriptName() {
  try {
    if (!process.argv[1]) return 'unknown';
    // Repo-relative (scripts/llm-scoring/index.ts, not the ambiguous index.ts).
    const rel = path.relative(REPO_ROOT, process.argv[1]);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.basename(process.argv[1]);
  } catch { return 'unknown'; }
}

/** Pure: aggregated state -> ledger rows. Old Map keys (model only) mean gemini. */
function buildRows(agg, { now = new Date(), workflow, script } = {}) {
  const rows = [];
  for (const [key, a] of agg) {
    const sep = key.indexOf('|');
    const provider = sep === -1 ? 'gemini' : key.slice(0, sep);
    const model = sep === -1 ? key : key.slice(sep + 1);
    const allUnknown = a.calls - a.unknownCalls === 0;
    const cached = a.cachedInputTokens || 0;
    const grounded = a.groundedCalls || 0;
    const row = {
      ts: now.toISOString(),
      provider,
      workflow: workflow || process.env.GITHUB_WORKFLOW || 'local',
      runId: process.env.GITHUB_RUN_ID || null,
      script: script || _scriptName(),
      model,
      calls: a.calls,
      unknownCalls: a.unknownCalls,
      inputTokens: allUnknown ? null : a.inputTokens,
      outputTokens: allUnknown ? null : a.outputTokens,
      costUsd: allUnknown ? null : estimateCostUsd(model, a.inputTokens, a.outputTokens, { provider, cachedInputTokens: cached, groundedCalls: grounded }),
    };
    if (cached) row.cachedInputTokens = cached;
    if (grounded) row.groundedCalls = grounded;
    if (a.dupCalls) row.dupCalls = a.dupCalls;
    rows.push(row);
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

/** Which metered endpoint a URL is, or null. */
function classifyUrl(url) {
  const u = String(url || '');
  if (u.includes(GEMINI_HOST)) {
    if (/:generateContent(\?|$)/.test(u)) return { provider: 'gemini', stream: false };
    if (/:streamGenerateContent(\?|$)/.test(u)) return { provider: 'gemini', stream: true };
    return null; // batch, countTokens, models, files
  }
  if (u.includes(OPENAI_HOST)) {
    if (/\/v1\/(chat\/completions|responses|embeddings)(\?|$)/.test(u)) return { provider: 'openai', stream: false };
    return null; // batches, files, models, polling a stored response
  }
  return null;
}

/** sha1 of (url without key, string body); null when the body is not a string. */
function requestHash(url, init) {
  try {
    const body = init && init.body;
    if (typeof body !== 'string') return null;
    const cleanUrl = String(url).replace(/([?&])key=[^&]*/g, '$1');
    const h = crypto.createHash('sha1').update(cleanUrl).update('\n');
    h.update(body.length > MAX_HASH_BYTES ? `${body.slice(0, MAX_HASH_BYTES)}#len=${body.length}` : body);
    return h.digest('hex');
  } catch { return null; }
}

function _requestModel(init) {
  try {
    const body = init && init.body;
    if (typeof body === 'string') {
      const m = body.slice(0, 64 * 1024).match(/"model"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
  } catch { /* ignore */ }
  return 'unknown';
}

const INSTALLED = Symbol.for('bsc.geminiUsage');
function install() {
  if (globalThis[INSTALLED] || typeof globalThis.fetch !== 'function') return;
  globalThis[INSTALLED] = true;
  const orig = globalThis.fetch;
  globalThis.fetch = async function llmObservedFetch(input, init) {
    let kind = null;
    let url = '';
    let hash = null;
    try {
      try { url = typeof input === 'string' ? input : (input && (input.url || String(input))) || ''; } catch { /* ignore */ }
      kind = classifyUrl(url);
      if (kind) hash = requestHash(url, init);
    } catch { kind = null; }
    const res = await orig.apply(this, arguments);
    if (!kind) return res;
    try {
      if (!res || !res.ok || typeof res.clone !== 'function') return res;
      let dup = false;
      if (hash) { dup = _seen.has(hash); _seen.add(hash); }
      const ct = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : 'application/json';
      if (kind.stream || !ct.includes('json')) {
        // Streaming: tokens arrive in chunks we never read. Count it, tokens unknown.
        const model = kind.provider === 'gemini' ? modelFromUrl(url) : _requestModel(init);
        recordUsage({ provider: kind.provider, model, usage: null, dup });
        return res;
      }
      // Read the clone WITHOUT awaiting it: the caller gets its response the
      // moment headers arrive, exactly as before. Awaiting here would make
      // fetch() resolve only after the full body downloaded, which moves the
      // openai SDK's timeout (cleared when fetch resolves) over the body and
      // can turn a slow body into a timeout + billed retry. The pending read
      // keeps the event loop alive, so rows still land before a natural exit.
      const clone = res.clone();
      const p = clone.json().then((json) => {
        if (kind.provider === 'gemini') {
          recordUsage({ provider: 'gemini', model: modelFromUrl(url), usage: extractUsage(json), grounded: json && geminiGrounded(json) ? 1 : 0, dup });
        } else {
          recordUsage({ provider: 'openai', model: (json && json.model) || _requestModel(init), usage: extractOpenAIUsage(json), grounded: openaiSearchCalls(json), dup });
        }
      }, () => {
        recordUsage({ provider: kind.provider, model: kind.provider === 'gemini' ? modelFromUrl(url) : _requestModel(init), usage: null, dup });
      }).finally(() => _pending.delete(p));
      _pending.add(p);
    } catch { /* record only */ }
    return res; // the caller always gets the original response
  };
  process.once('exit', flush);
}

module.exports = {
  extractUsage,
  extractOpenAIUsage,
  geminiGrounded,
  openaiSearchCalls,
  estimateCostUsd,
  modelFromUrl,
  classifyUrl,
  requestHash,
  recordUsage,
  recordGeminiUsage,
  buildRows,
  flush,
  settle,
  install,
  LEDGER_PATH,
};
