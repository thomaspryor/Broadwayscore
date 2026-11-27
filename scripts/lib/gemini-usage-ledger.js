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
 * (batchGenerateContent, /v1/batches) are not observable on the wire, so
 * code that reads batch results calls recordBatchUsage() (kind 'batch',
 * priced at BATCH_DISCOUNT). Anthropic /v1/messages is metered by the same
 * fetch wrapper (the SDK uses global fetch). Session-side curl calls
 * (slash commands, hooks) go through scripts/log-llm-call.js (kind 'session').
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
const ANTHROPIC_HOST = 'api.anthropic.com';
// Batch APIs bill at half the synchronous list price (all three vendors).
const BATCH_DISCOUNT = 0.5;
const REPO_ROOT = path.join(__dirname, '..', '..');
// Session rows folded in at wrap-up (BRO-8108); see foldSessionRows().
const TRACKED_SESSION_LEDGER_PATH = path.join(REPO_ROOT, 'data', 'audit', 'llm-session-usage.jsonl');

// Gemini: USD per 1M tokens (input, output). Published list prices, standard
// tier; an estimate for attribution, not an invoice. Cached input bills at a
// quarter of the input rate (Gemini 2.5 context caching). Unknown -> null.
const PRICES_PER_M = [
  [/gemini-4-carbon/, [4, 20]], // BRO-8016 reviewer pin: list price from 2026-12-01 ($2/$10 intro until then; apidog, techjack)
  [/gemini-3\.5-flash-lite/, [0.30, 2.50]], // Google pricing page, checked 2026-11-21 (BRO-7511: utility alias + scoring pin)
  [/gemini-3\.8-flash(?!-)/, [1.50, 7.50]],
  [/gemini-3-flash-preview/, [0.50, 3.00]], // BRO-8108: the Gemini CLI's own helper calls during a review; Google pricing page (Gemini 3 Flash) // BRO-7511: list price from 2027-01-01 (half that until then)
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
  // BRO-7341 candidates. luna = post-2026-07-30 list price (secondary sources);
  // sol matches research-cost.js (checked 2026-11-11, BRO-7524).
  'gpt-6-luna': { input: 0.20, cached: 0.02, output: 1.20 },
  'gpt-5.6-luna': { input: 0.20, cached: 0.02, output: 1.20 },
  'gpt-5.6-sol': { input: 4.00, cached: 0.40, output: 20.00 },
  'text-embedding-3-small': { input: 0.02, cached: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, cached: 0.13, output: 0 },
};

// Anthropic: autonomous-budget.js MODEL_PRICES is the one table ($/MTok in, out).
// Cache writes bill at 1.25x input, cache reads at 0.1x (5-min ephemeral TTL).
function anthropicRates(model) {
  try {
    const hit = require('./autonomous-budget').MODEL_PRICES.find((x) => x.re.test(String(model || '')));
    return hit ? { input: hit.inUSD, output: hit.outUSD } : null;
  } catch { return null; }
}

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

/** Anthropic Messages response JSON -> usage or null. Cache reads/writes are separate counters on the wire. */
function extractAnthropicUsage(json) {
  const u = json && json.usage;
  if (!u || typeof u !== 'object' || !Number.isFinite(u.input_tokens)) return null;
  const read = Number.isFinite(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0;
  const write = Number.isFinite(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0;
  // Fold cache traffic into inputTokens (cachedInputTokens = reads) so one
  // row shape serves every provider; cache writes carry their own premium below.
  const out = { inputTokens: u.input_tokens + read + write, outputTokens: Number.isFinite(u.output_tokens) ? u.output_tokens : 0 };
  if (read > 0) out.cachedInputTokens = read;
  if (write > 0) out.cacheWriteTokens = write;
  return out;
}

/** OpenAI Responses API: number of web_search tool calls (upper bound). */
function openaiSearchCalls(json) {
  const out = json && Array.isArray(json.output) ? json.output : [];
  return out.filter((i) => i && (i.type === 'web_search_call' || i.type === 'web_search')).length;
}

/**
 * Estimated USD, or null for an unknown model. Old 3-argument calls price
 * Gemini. opts: { provider='gemini'|'openai'|'anthropic', cachedInputTokens=0,
 * cacheWriteTokens=0, groundedCalls=0, discount=1 (0.5 for Batch API) }
 */
function estimateCostUsd(model, inputTokens, outputTokens, opts = {}) {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const provider = opts.provider || 'gemini';
  const cached = Math.min(inputTokens, Number(opts.cachedInputTokens) || 0);
  const searches = Number(opts.groundedCalls) || 0;
  const factor = Number.isFinite(opts.discount) && opts.discount > 0 ? opts.discount : 1;
  const write = Math.min(inputTokens - cached, Number(opts.cacheWriteTokens) || 0);
  let usd;
  if (provider === 'anthropic') {
    const r = anthropicRates(model);
    if (!r) return null;
    usd = ((inputTokens - cached - write) * r.input + write * r.input * 1.25 + cached * r.input * 0.1 + outputTokens * r.output) / 1e6;
  } else if (provider === 'openai') {
    const r = openaiRates(model);
    if (!r) return null;
    usd = ((inputTokens - cached) * r.input + cached * r.cached + outputTokens * r.output) / 1e6 + searches * OPENAI_SEARCH_USD;
  } else {
    const hit = PRICES_PER_M.find(([re]) => re.test(String(model || '')));
    if (!hit) return null;
    const [pin, pout] = hit[1];
    usd = ((inputTokens - cached) * pin + cached * pin * GEMINI_CACHED_FACTOR + outputTokens * pout) / 1e6 + searches * GEMINI_GROUNDED_USD;
  }
  return +(usd * factor).toFixed(6);
}

function modelFromUrl(url) {
  const m = String(url || '').match(/\/models\/([^:/?]+)/);
  return m ? m[1] : 'unknown';
}

const _agg = new Map(); // `${provider}|${model}` -> counters
const _seen = new Set(); // request hashes, this process only
const _pending = new Set(); // in-flight body reads
let _sessionUsageCaller = null;

// A reviewer runs inside a session, even though its calls use the fetch meter.
function setSessionUsageCaller(caller) { _sessionUsageCaller = caller || null; }

/** Resolves once every in-flight body read has been recorded (tests, explicit flushes). */
function settle() {
  return Promise.all([..._pending]).then(() => undefined);
}

function _counter(key) {
  let a = _agg.get(key);
  if (!a) {
    a = { calls: 0, unknownCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, groundedCalls: 0, dupCalls: 0 };
    _agg.set(key, a);
  }
  return a;
}

/** Add one call. usage is an extract*Usage() result or null (unknown). Never throws. */
function recordUsage({ provider = 'gemini', model, usage, grounded = 0, dup = false, kind = 'api', caller = null }) {
  try {
    if (kind === 'api' && _sessionUsageCaller) { kind = 'session'; caller = _sessionUsageCaller; }
    const a = _counter([provider, model || 'unknown', kind, caller || ''].join('|'));
    a.calls += 1;
    if (dup) a.dupCalls += 1;
    a.groundedCalls += Number(grounded) || 0;
    if (!usage || usage.inputTokens === null) a.unknownCalls += 1;
    else {
      a.inputTokens += usage.inputTokens;
      a.outputTokens += usage.outputTokens;
      a.cachedInputTokens += usage.cachedInputTokens || 0;
      a.cacheWriteTokens += usage.cacheWriteTokens || 0;
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
    // key = provider|model|kind|caller (older callers pass `provider|model` or bare model).
    const parts = key.split('|');
    const provider = parts.length === 1 ? 'gemini' : parts[0];
    const model = parts.length === 1 ? key : parts[1];
    const kind = parts[2] || 'api';
    const caller = parts[3] || '';
    const allUnknown = a.calls - a.unknownCalls === 0;
    const cached = a.cachedInputTokens || 0;
    const grounded = a.groundedCalls || 0;
    const row = {
      ts: now.toISOString(),
      provider,
      workflow: workflow || process.env.GITHUB_WORKFLOW || 'local',
      runId: process.env.GITHUB_RUN_ID || null,
      script: script || _scriptName(),
      kind, // api | batch | session
      caller: caller || script || _scriptName(),
      model,
      calls: a.calls,
      unknownCalls: a.unknownCalls,
      inputTokens: allUnknown ? null : a.inputTokens,
      outputTokens: allUnknown ? null : a.outputTokens,
      costUsd: allUnknown ? null : estimateCostUsd(model, a.inputTokens, a.outputTokens, { provider, cachedInputTokens: cached, cacheWriteTokens: a.cacheWriteTokens || 0, groundedCalls: grounded, discount: kind === 'batch' ? BATCH_DISCOUNT : 1 }),
    };
    if (cached) row.cachedInputTokens = cached;
    if (a.cacheWriteTokens) row.cacheWriteTokens = a.cacheWriteTokens;
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

let _flushHooked = false;
function _hookFlush() {
  if (_flushHooked) return;
  _flushHooked = true;
  process.once('exit', flush);
}

/**
 * Batch API results carry per-item usage but no wire-level signal we can
 * observe, so the code that reads results reports them here. results is a
 * list of { usage?: { input, output, cacheRead?, cacheWrite? } } (the
 * batch-clients VendorResult shape). Priced at BATCH_DISCOUNT. Never throws.
 */
function recordBatchUsage({ provider, model, results, caller = null }) {
  try {
    _hookFlush();
    for (const r of results || []) {
      const u = r && r.usage;
      const usage = u && Number.isFinite(u.input)
        ? { inputTokens: u.input + (u.cacheRead || 0) + (u.cacheWrite || 0), outputTokens: u.output || 0, ...(u.cacheRead ? { cachedInputTokens: u.cacheRead } : {}), ...(u.cacheWrite ? { cacheWriteTokens: u.cacheWrite } : {}) }
        : null;
      recordUsage({ provider, model, usage, kind: 'batch', caller });
    }
  } catch { /* record only */ }
}

/** Provider response JSON -> usage, by provider. Pure. */
function usageFromResponse(provider, json) {
  if (provider === 'anthropic') return extractAnthropicUsage(json);
  if (provider === 'openai') return extractOpenAIUsage(json);
  return extractUsage(json);
}

/**
 * Session rows live OUTSIDE the repo (~/.claude/state): the tracked ledger is
 * committed by CI, and a session's append would leave an uncommitted change on
 * it in the main checkout (or die with a removed worktree). CI-run sessions
 * (GITHUB_ACTIONS) write the tracked ledger so the workflow's save step keeps them.
 */
function sessionLedgerPath() {
  if (process.env.LLM_SESSION_LEDGER_PATH) return process.env.LLM_SESSION_LEDGER_PATH;
  if (process.env.GEMINI_USAGE_LEDGER_PATH || process.env.GITHUB_ACTIONS || isTestRun()) return _ledgerPath();
  return path.join(os.homedir(), '.claude', 'state', 'llm-session-usage.jsonl');
}

/**
 * BRO-8108: a cloud session's home folder dies with its container, so its session rows (every
 * /ship-check and /plan-review Gemini run) never reached any ledger: a ~$190/day Carbon bill
 * showed as ~$5. Writing the tracked file mid-session tripped review.js's tree tripwire when
 * reviewers ran in parallel, so rows stay in the home file during the session and are copied
 * here at wrap-up (record-claude-session-cost.js), into the tracked merge=union file the
 * session commits with its cost row. Copies only lines not already there. Returns rows added.
 */
function foldSessionRows({ from = sessionLedgerPath(), to = TRACKED_SESSION_LEDGER_PATH } = {}) {
  // Never fold the main ledger (CI, or GEMINI_USAGE_LEDGER_PATH set): it is committed already.
  if (path.resolve(from) === path.resolve(to) || path.resolve(from) === path.resolve(_ledgerPath())) return 0;
  // A missing file is "nothing to fold"; any other read error throws so the caller reports it.
  const lines = (p) => { try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  const have = new Set(lines(to));
  const isSessionRow = (l) => { try { return JSON.parse(l).kind === 'session'; } catch { return false; } };
  const add = lines(from).filter((l) => { if (have.has(l) || !isSessionRow(l)) return false; have.add(l); return true; });
  if (!add.length) return 0;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // A hand-edited or conflict-resolved file may lack its final newline: never glue two rows.
  let lead = '';
  try { const st = fs.statSync(to); if (st.size) { const fd = fs.openSync(to, 'r'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, st.size - 1); fs.closeSync(fd); if (b[0] !== 10) lead = '\n'; } } catch { /* missing: no lead */ }
  fs.appendFileSync(to, lead + add.join('\n') + '\n');
  return add.length;
}

/**
 * Session-side call (slash command curl, hook, visual-qa): append ONE row now
 * (kind 'session'), since a shell has no process-exit moment to flush at.
 * Returns the row, or null on bad input. Never throws.
 */
function logSessionCall({ provider, model, response, caller, now = new Date() }) {
  try {
    if (!['gemini', 'openai', 'anthropic'].includes(provider)) return null;
    const json = typeof response === 'string' ? JSON.parse(response) : response;
    const m = model || (json && (json.model || json.modelVersion)) || 'unknown';
    const key = [provider, m, 'session', caller || 'session'].join('|');
    const agg = new Map();
    const a = { calls: 1, unknownCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, groundedCalls: 0, dupCalls: 0 };
    const usage = usageFromResponse(provider, json);
    if (!usage || usage.inputTokens === null) a.unknownCalls = 1;
    else { a.inputTokens = usage.inputTokens; a.outputTokens = usage.outputTokens; a.cachedInputTokens = usage.cachedInputTokens || 0; a.cacheWriteTokens = usage.cacheWriteTokens || 0; }
    if (provider === 'gemini' && json && geminiGrounded(json)) a.groundedCalls = 1;
    agg.set(key, a);
    const rows = buildRows(agg, { now, script: caller || 'session' });
    if (process.env.GEMINI_USAGE_DISABLED !== '1') {
      const p = sessionLedgerPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    return rows[0];
  } catch { return null; }
}

/**
 * BRO-7522: one row for a `claude -p` check the Codex runner ran. costUsd is the CLI's own
 * total_cost_usd (a real figure, not a list-price estimate). auth says what it billed:
 * 'api-key' (pay-as-you-go ANTHROPIC_API_KEY) or 'oauth' (subscription token). Pure.
 */
function buildClaudeCheckRow({ model, costUsd, error = null, card = null, auth, now = new Date(), workflow, runId, script = 'scripts/codex/daily-runner.js' }) {
  return {
    ts: now.toISOString(),
    provider: 'anthropic',
    workflow: workflow || process.env.GITHUB_WORKFLOW || 'local',
    runId: runId || process.env.GITHUB_RUN_ID || null,
    script,
    model: String(model || 'unknown'),
    calls: 1,
    unknownCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: Number.isFinite(costUsd) ? costUsd : null,
    auth: auth || (process.env.ANTHROPIC_API_KEY ? 'api-key' : 'oauth'),
    ...(card ? { card } : {}),
    ...(error ? { error: String(error) } : {}),
  };
}

/** Append one claude-check row. Never throws (telemetry must not fail a card). -> the row, or null. */
function recordClaudeCheck(fields) {
  try {
    if (process.env.GEMINI_USAGE_DISABLED === '1') return null;
    const row = buildClaudeCheckRow(fields);
    // CODEX_CHECK_USAGE_AUTH_PATH (the name matches the runner's SECRET_ENV scrub, so Codex and the
    // reviewer never see it) sends the row to the CI scratch file; the generic override would also
    // switch off the test-run guard for every child that inherits it.
    const p = process.env.CODEX_CHECK_USAGE_AUTH_PATH || _ledgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + '\n');
    return row;
  } catch { return null; }
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
  if (u.includes(ANTHROPIC_HOST)) {
    if (/\/v1\/messages(\?|$)/.test(u)) return { provider: 'anthropic', stream: false };
    return null; // message batches (recorded where results are read), models, count_tokens
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

/**
 * Node's https.request never goes through fetch, and ~20 scripts call
 * Anthropic that way. Observe the response of a metered endpoint after the
 * caller's own callback has attached its listeners, so we never change how
 * the caller consumes the stream. Compressed or non-JSON bodies count as
 * unknown. Never throws.
 */
function observeHttpsResponse(kind, url, res) {
  try {
    const chunks = [];
    const compressed = !!(res.headers && res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity');
    res.on('data', (c) => { if (!compressed) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
    res.on('end', () => {
      try {
        if (!(res.statusCode >= 200 && res.statusCode < 300)) return;
        let json = null;
        if (!compressed && !kind.stream) { try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; } }
        const model = kind.provider === 'gemini' ? modelFromUrl(url) : ((json && json.model) || 'unknown');
        const usage = json ? usageFromResponse(kind.provider, json) : null;
        recordUsage({ provider: kind.provider, model, usage, grounded: json && kind.provider === 'gemini' && geminiGrounded(json) ? 1 : 0 });
      } catch { /* record only */ }
    });
  } catch { /* record only */ }
}

function _installHttps() {
  try {
    const https = require('https');
    if (https.request && https.request.__llmMetered) return;
    const orig = https.request;
    const wrapped = function llmObservedRequest(...args) {
      try {
        // Forms: (url|URL [, options][, cb]) or (options [, cb]). Only the callback form is observable.
        const ci = args.findIndex((a) => typeof a === 'function');
        if (ci !== -1) {
          const first = args[0];
          const opts = (first && typeof first === 'object' && !(first instanceof URL)) ? first : (args[1] && typeof args[1] === 'object' ? args[1] : {});
          let host = opts.hostname || opts.host || '';
          let p = opts.path || '';
          if (typeof first === 'string' || first instanceof URL) { const u = new URL(String(first)); host = host || u.host; p = p || u.pathname + u.search; }
          const kind = classifyUrl(`https://${host}${p}`);
          if (kind) {
            const cb = args[ci];
            const full = `https://${host}${p}`;
            args[ci] = function meteredCallback(res) {
              const r = cb.apply(this, arguments); // caller attaches its listeners first
              observeHttpsResponse(kind, full, res);
              return r;
            };
          }
        }
      } catch { /* record only */ }
      return orig.apply(this, args);
    };
    wrapped.__llmMetered = true;
    https.request = wrapped;
  } catch { /* record only */ }
}

const INSTALLED = Symbol.for('bsc.geminiUsage');
function install() {
  if (globalThis[INSTALLED] || typeof globalThis.fetch !== 'function') return;
  globalThis[INSTALLED] = true;
  _installHttps();
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
        } else if (kind.provider === 'anthropic') {
          recordUsage({ provider: 'anthropic', model: (json && json.model) || _requestModel(init), usage: extractAnthropicUsage(json), dup });
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
  extractAnthropicUsage,
  observeHttpsResponse,
  BATCH_DISCOUNT,
  geminiGrounded,
  openaiSearchCalls,
  estimateCostUsd,
  modelFromUrl,
  classifyUrl,
  requestHash,
  recordUsage,
  setSessionUsageCaller,
  recordBatchUsage,
  logSessionCall,
  sessionLedgerPath,
  usageFromResponse,
  recordGeminiUsage,
  buildRows,
  buildClaudeCheckRow,
  recordClaudeCheck,
  flush,
  settle,
  install,
  LEDGER_PATH,
  TRACKED_SESSION_LEDGER_PATH,
  foldSessionRows,
};
