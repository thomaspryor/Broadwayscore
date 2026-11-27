#!/usr/bin/env node
/**
 * scripts/gemini/review.js: Gemini code reviewer for /ship-check and /plan-review (BRO-7987, rebuilt BRO-8160).
 *
 * Sends the caller's prompt plus a packed bundle of the code under review (review-bundle.js) in ONE
 * Gemini request. It used to run the Gemini CLI as an agent that opened files with tools; each tool
 * turn re-sent the whole conversation, so a review cost 0.6M to 6M input tokens and the daily bill
 * reached about $190 (Google Cloud anomaly 2026-11-23). One request with the same material costs
 * cents and, on planted bugs, caught as much (BRO-8160 step 0: 3 of 3 planted bugs, 8 of 8 runs).
 * With no tools the model cannot change the working tree, so the old read-only policy and tree
 * tripwire are gone with the CLI.
 *
 * Usage:  <prompt on stdin> | node scripts/gemini/review.js --caller=ship-check [--base=<ref>]
 *           [--model=M] [--timeout-sec=900] [--budget-chars=N]
 *   --base   review the change from the merge base with <ref> to the working tree (ship-check).
 *            Without it the files the prompt names are attached (plan-review).
 * stdout: the review text (only when exit 0)
 * stderr: one status line: `GEMINI-REVIEW: ok|partial|no-reads model=M reads=N partial=N unbundled=N ...`
 *         (reads = files attached, whole or in part), or `MISSING: <why>`, `EMPTY: <why>`, `FAILED: <why>`
 * Exit:   0 review printed | 3 MISSING (fall back) | 1 EMPTY/FAILED
 * Env:    GEMINI_API_KEY (required), GEMINI_REVIEW_MODEL, GEMINI_REVIEW_THINKING (low|medium|high)
 * Never prints the API key.
 */
'use strict';
const fs = require('fs');
const { buildBundle, isSecretPath, DEFAULT_BUDGET_CHARS } = require('./review-bundle');

// BRO-8108: gemini-3.8-flash (models.js GEMINI_REVIEW). Medium thinking: on real commits it found a
// bug low thinking missed and guessed less, at $0.03 to $0.30 a review (BRO-8160 step 0).
const DEFAULT_MODEL = require('../lib/models').GEMINI_REVIEW;
const DEFAULT_THINKING = 'medium';
const MAX_OUTPUT_TOKENS = 32768; // thinking counts against this; 8192 truncated 5 of 6 step-0 runs
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const NO_READS_HEADER = 'NOTE: Gemini opened no repository files in this review; treat every file:line claim below as unverified.';

/** The generateContent body. thinking=null leaves thinking at the model default. */
function buildRequest(text, { thinking = DEFAULT_THINKING, maxOutputTokens = MAX_OUTPUT_TOKENS } = {}) {
  return {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { maxOutputTokens, ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}) },
  };
}

/** generateContent JSON -> { text, finishReason, usage, blocked } (thought parts dropped). */
function parseResponse(j) {
  const cand = (j && Array.isArray(j.candidates) && j.candidates[0]) || {};
  const parts = (cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
  const text = parts.filter((p) => p && !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
  const u = (j && j.usageMetadata) || {};
  return {
    text,
    finishReason: cand.finishReason || null,
    blocked: (j && j.promptFeedback && j.promptFeedback.blockReason) || null,
    usage: {
      prompt: Number(u.promptTokenCount) || 0,
      cached: Number(u.cachedContentTokenCount) || 0,
      output: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0),
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One review request with retries. 429/5xx and network errors retry up to 3 times (2s, 4s, 8s) inside
 * the deadline. An HTTP 400 that names thinking retries once without a thinking setting (a model that
 * does not take thinkingLevel). An empty answer cut at MAX_TOKENS retries once on low thinking.
 * -> { parsed, thinking } | { fail, empty? }
 */
async function review({ text, model, key, deadline, thinking, fetchImpl = globalThis.fetch, onFailedCall = () => {}, sleepImpl = sleep }) {
  let think = thinking;
  let transient = 0;
  let thinkRetry = false;
  let tokenRetry = false;
  // Never sleep past the deadline; the loop then reports the timeout.
  const backoff = () => sleepImpl(Math.max(0, Math.min(2000 * 2 ** (transient - 1), deadline - Date.now() - 1000)));
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 1000) return { fail: 'timed out before Gemini answered' };
    let res;
    let body;
    try {
      res = await fetchImpl(`${API}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(buildRequest(text, { thinking: think })),
        signal: AbortSignal.timeout(left),
      });
      // A timeout while the body streams in must read as a timeout, not as an empty answer.
      body = await res.json().catch((e) => { if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw e; return null; });
    } catch (e) {
      onFailedCall();
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return { fail: `Gemini timed out after ${Math.round(left / 1000)}s` };
      if (transient++ < 3) { await backoff(); continue; }
      return { fail: `Gemini network error: ${String(e && e.message).slice(0, 160)}` };
    }
    if (!res.ok) {
      // A 5xx may have run (and billed) the model; a 4xx was refused before it ran.
      if (res.status >= 500) onFailedCall();
      const msg = String((body && body.error && body.error.message) || '').slice(0, 200);
      if (RETRY_STATUS.has(res.status) && transient++ < 3) { await backoff(); continue; }
      if (res.status === 400 && think && !thinkRetry && /thinking/i.test(msg)) { thinkRetry = true; think = null; continue; }
      return { fail: `Gemini HTTP ${res.status}${msg ? `: ${msg}` : ''}` };
    }
    const parsed = parseResponse(body);
    if (parsed.blocked) return { fail: `prompt blocked by Gemini (${parsed.blocked})`, empty: true };
    if (!parsed.text && parsed.finishReason === 'MAX_TOKENS' && !tokenRetry && think !== 'low') { tokenRetry = true; think = 'low'; continue; }
    if (!parsed.text) return { fail: `Gemini returned no answer text (finishReason ${parsed.finishReason || 'none'})`, empty: true };
    return { parsed, thinking: think || 'default' };
  }
}

function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
}

/** Drop diff sections for secret-named files from the caller's prompt: the bundle never sends them, so neither does the diff. */
function redactSecretDiffs(prompt) {
  const dropped = [];
  const out = String(prompt).split(/(?=^diff --git )/m).map((sec) => {
    const m = /^diff --git (?:"?a\/.*?"? )"?b\/(.*?)"?$/m.exec(sec);
    if (!m || !sec.startsWith('diff --git ') || !isSecretPath(m[1])) return sec;
    dropped.push(m[1]);
    const tail = /\n(=== [^\n]*===[^\n]*\n?[\s\S]*)$/.exec(sec); // keep a cut marker or section header that followed
    return `diff --git a/${m[1]} b/${m[1]}\n(diff withheld: the name looks like a secret)\n${tail ? tail[1] : ''}`;
  }).join('');
  return { text: out, dropped };
}

async function main() {
  require('../lib/llm-usage-install'); // LLM spend meter, before any request (BRO-5043); here so importers of this module are untouched
  let ledger = null;
  try { ledger = require('../lib/gemini-usage-ledger'); } catch { /* record only */ }
  const done = async (code, line) => {
    try { if (ledger) await ledger.settle(); } catch { /* record only */ }
    process.stderr.write(line + '\n');
    process.exit(code);
  };
  const caller = arg('caller', 'gemini-review');
  if (ledger) ledger.setSessionUsageCaller(caller);
  const model = arg('model', process.env.GEMINI_REVIEW_MODEL || DEFAULT_MODEL);
  const thinking = process.env.GEMINI_REVIEW_THINKING || DEFAULT_THINKING;
  const timeoutSec = Number(arg('timeout-sec', '900'));
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return done(1, `FAILED: --timeout-sec must be a positive number, got '${arg('timeout-sec')}'`);
  const budgetChars = Number(arg('budget-chars', String(DEFAULT_BUDGET_CHARS)));
  if (!Number.isFinite(budgetChars) || budgetChars < 0) return done(1, `FAILED: --budget-chars must be a number >= 0, got '${arg('budget-chars')}'`);
  const base = arg('base', '');
  const deadline = Date.now() + timeoutSec * 1000;

  const key = process.env.GEMINI_API_KEY;
  if (!key) return done(3, 'MISSING: GEMINI_API_KEY is not set');
  let prompt = '';
  try { prompt = fs.readFileSync(0, 'utf8'); } catch { /* empty */ }
  if (!prompt.trim()) return done(1, 'FAILED: no prompt on stdin');

  const bundle = buildBundle({ cwd: process.cwd(), base: base || undefined, prompt, budgetChars });
  if (bundle.error) return done(1, `FAILED: could not build the review bundle: ${bundle.error}`);

  // Local and cloud sessions write the session ledger (folded into the tracked one at wrap-up,
  // BRO-8108); in GitHub Actions sessionLedgerPath() is the tracked CI ledger itself.
  if (ledger && !process.env.GEMINI_USAGE_LEDGER_PATH) {
    try { process.env.GEMINI_USAGE_LEDGER_PATH = ledger.sessionLedgerPath(); } catch { /* record only */ }
  }
  // The meter counts only answered calls; a failed one may still be billed, so log it as unknown size.
  const onFailedCall = () => { try { if (ledger) ledger.logSessionCall({ provider: 'gemini', model, response: {}, caller }); } catch { /* record only */ } };

  const red = redactSecretDiffs(prompt);
  const r = await review({ text: `${red.text.trimEnd()}\n\n${bundle.text}`, model, key, deadline, thinking, onFailedCall });
  if (r.fail) return done(1, `${r.empty ? 'EMPTY' : 'FAILED'}: ${r.fail}`);

  const parsed = { reads: bundle.given.length + bundle.partial.length, ...r.parsed };
  const u = parsed.usage;
  let usd = null;
  try { usd = ledger.estimateCostUsd(model, u.prompt, u.output, { cachedInputTokens: u.cached }); } catch { /* unknown */ }
  const truncated = parsed.finishReason === 'MAX_TOKENS';
  const cut = truncated ? '\n\n(NOTE: this answer was cut at the output limit.)' : '';
  // More changed files left out than attached, or an answer cut short, is a partial review: it is
  // printed and used, but the land gate (review-coverage.mjs, `ok` only) does not count it as coverage.
  const missedChanged = bundle.omitted.filter((o) => !/^untracked|^past the first/.test(o.why)).length;
  const status = parsed.reads === 0 ? 'no-reads' : (truncated || missedChanged > parsed.reads ? 'partial' : 'ok');
  process.stdout.write((parsed.reads === 0 ? NO_READS_HEADER + '\n\n' : '') + parsed.text + cut + '\n');
  return done(0, `GEMINI-REVIEW: ${status} model=${model} reads=${parsed.reads} partial=${bundle.partial.length} unbundled=${bundle.omitted.length} callers=${bundle.callerLines} tokens=${u.prompt + u.output} usd=${usd == null ? 'unknown' : usd.toFixed(4)} thinking=${r.thinking}${red.dropped.length ? ` withheld=${red.dropped.length}` : ''}`);
}

module.exports = { buildRequest, parseResponse, review, redactSecretDiffs, NO_READS_HEADER, DEFAULT_THINKING, MAX_OUTPUT_TOKENS };
if (require.main === module) main().catch((e) => { process.stderr.write(`FAILED: ${String((e && e.stack) || e).split('\n')[0].slice(0, 300)}\n`); process.exit(1); });
