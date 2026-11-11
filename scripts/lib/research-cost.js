'use strict';
/**
 * OpenAI Responses API cost for one research call, computed from the
 * response's own usage fields (BRO-4990).
 *
 * The old estimate in deep-research-commercial.js billed input + output
 * tokens only. It left out the web search tool fee ($10 per 1k calls for
 * reasoning models, both web_search and web_search_preview) and billed
 * cached input at the full rate, so the weekly spend cap undercounted.
 *
 * Rates: USD per 1M tokens, standard tier, from
 * https://developers.openai.com/api/docs/pricing (checked 2026-10-10).
 * Search content tokens for reasoning models are already inside
 * usage.input_tokens and billed at model rates there.
 */

const RATES = {
  'o4-mini': { input: 1.10, cached: 0.275, output: 4.40 },
  'o3': { input: 2.00, cached: 0.50, output: 8.00 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.00 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.50 },
  'gpt-5.4': { input: 2.50, cached: 0.25, output: 15.00 },
  // GPT-5.6 family, checked 2026-11-11 (BRO-7339). Replacements OpenAI names for
  // the 2026-12-11 shutdowns: gpt-5-mini->terra, o3/gpt-5/gpt-5-pro->sol, gpt-5-nano->luna.
  'gpt-5.6-luna': { input: 0.20, cached: 0.02, output: 1.20 },
  'gpt-5.6-terra': { input: 2.00, cached: 0.20, output: 12.00 },
  'gpt-5.6-sol': { input: 4.00, cached: 0.40, output: 20.00 },
  // Shut down by OpenAI 2026-07-23; kept so old cost-log rows still price.
  'o4-mini-deep-research': { input: 2.00, cached: 0.50, output: 8.00 },
  'o3-deep-research': { input: 10.00, cached: 2.50, output: 40.00 },
};

// Per web search call, reasoning models (o-series, gpt-5.x).
const WEB_SEARCH_CALL_USD = 0.01;

// Unknown models price at the most expensive known rate so a typo'd or new
// model can never make the spend cap look roomier than it is.
const FALLBACK_RATES = { input: 10.00, cached: 2.50, output: 40.00 };

function ratesFor(model) {
  if (RATES[model]) return RATES[model];
  // Dated snapshots (gpt-5.4-mini-2026-03-17) price like their alias.
  const alias = String(model || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return RATES[alias] || FALLBACK_RATES;
}

/**
 * Per-token USD plus the per-search fee, from the one RATES table, for scripts
 * that meter their own spend (dual-model-client, audit-review-crossmodel,
 * fact-check-historical-sample, aeo-visibility). A model swap is then one line
 * in models.js; unknown ids price at FALLBACK_RATES (never under-count).
 * @param {string} model
 * @returns {{in:number, out:number, search:number}}
 */
function perTokenUsd(model) {
  const r = ratesFor(model);
  return { in: r.input / 1e6, out: r.output / 1e6, search: WEB_SEARCH_CALL_USD };
}

/**
 * Count billable web search calls in a Responses API output array. Every
 * web_search_call item is counted (an upper bound: open_page/find actions
 * inside a call may not bill separately).
 * @param {object[]} output
 * @returns {number}
 */
function countSearchCalls(output) {
  return (output || []).filter(i => i && (i.type === 'web_search_call' || i.type === 'web_search')).length;
}

/**
 * @param {object} usage - response.usage ({input_tokens, output_tokens, input_tokens_details.cached_tokens})
 * @param {string} model
 * @param {number} [searchCalls=0]
 * @returns {{total:number, tokens:number, search:number}}
 */
function researchCallCost(usage, model, searchCalls = 0) {
  const r = ratesFor(model);
  const u = usage || {};
  const input = u.input_tokens || 0;
  const cached = Math.min(input, (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0);
  const output = u.output_tokens || 0;
  const tokens = ((input - cached) * r.input + cached * r.cached + output * r.output) / 1e6;
  const search = (searchCalls || 0) * WEB_SEARCH_CALL_USD;
  return { total: tokens + search, tokens, search };
}

// OpenAI retirement dates (developers.openai.com/api/docs/deprecations,
// checked 2026-10-10). The research cron silently produced nothing after the
// deep-research models died on 2026-07-23 (BRO-123); a known date lets the
// script warn weeks ahead and refuse after the date instead.
const MODEL_SHUTDOWNS = {
  'o4-mini': '2026-10-23',
  'o3-mini': '2026-10-23',
  'o4-mini-deep-research': '2026-07-23',
  'o3-deep-research': '2026-07-23',
  // 2026-06-11 notice (checked 2026-11-11, BRO-7339). The owner email of 2026-11
  // read "5.5 / 5.4 mini / 5.4 nano / 5.5 pro", but the docs table lists these ids.
  'gpt-5': '2026-12-11',
  'gpt-5-mini': '2026-12-11',
  'gpt-5-nano': '2026-12-11',
  'gpt-5-pro': '2026-12-11',
  'o3': '2026-12-11',
  'o3-pro': '2026-12-11',
  // 2026-10-01 notice.
  'gpt-5.4-nano': '2027-04-01',
  'gpt-5.1': '2027-04-01',
  'gpt-5.3-codex': '2027-04-01',
  // gpt-4o family (2027-01-14) is deliberately NOT listed yet: the scoring
  // ensemble still runs on it (CLAUDE.md rule 13 A/B first), and listing it
  // would fail the any-announced-shutdown guard in research-cost.test.mjs.
};

// Models the repo knowingly still uses past an announced shutdown, each waiting on a
// migration that needs its own A/B (CLAUDE.md rule 13). Kept apart from MODEL_SHUTDOWNS
// because that table feeds the any-announced-shutdown guard in research-cost.test.mjs;
// scripts/audit-openai-retirements.js reads both, so the countdown is still tracked.
const ACCEPTED_SHUTDOWNS = {
  // BRO-7341: the review-scoring ensemble's OpenAI leg (models.js SCORING_OPENAI,
  // COMPARATIVE_OPENAI, GPT4O, GPT4O_MINI). Moving it shifts scores corpus-wide, so it
  // needs its own A/B (rule 13) and is not part of the BRO-7339 call-site sweep.
  'gpt-4o': '2027-01-14',
  'gpt-4o-mini': '2027-01-14',
  'gpt-4.1': '2027-01-14',
  'gpt-4.1-mini': '2027-01-14',
};

/**
 * @param {string} model
 * @param {string} todayStr - YYYY-MM-DD
 * @param {number} [warnDays=30]
 * @returns {{status:'ok'|'warn'|'dead', shutdown:string|null, daysLeft:number|null}}
 */
function modelShutdownStatus(model, todayStr, warnDays = 30) {
  const alias = String(model || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const shutdown = MODEL_SHUTDOWNS[model] || MODEL_SHUTDOWNS[alias] || null;
  if (!shutdown) return { status: 'ok', shutdown: null, daysLeft: null };
  const daysLeft = Math.round((Date.parse(shutdown) - Date.parse(todayStr)) / 86400000);
  return { status: daysLeft <= 0 ? 'dead' : daysLeft <= warnDays ? 'warn' : 'ok', shutdown, daysLeft };
}

module.exports = { RATES, WEB_SEARCH_CALL_USD, MODEL_SHUTDOWNS, ACCEPTED_SHUTDOWNS, ratesFor, perTokenUsd, countSearchCalls, researchCallCost, modelShutdownStatus };
