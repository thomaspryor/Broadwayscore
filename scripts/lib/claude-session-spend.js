'use strict';
/**
 * Pricing + overflow forecasting for Claude Code session usage (BRO-3026).
 *
 * DELIBERATELY NOT part of scripts/lib/provider-spend-core.js. That module's
 * model is a billing-API cycle counter -> delta -> streak with fixed
 * per-provider unit costs. Claude Code spend is per-message tokens with cache
 * multipliers, absorbed by a WEEKLY plan allowance, with only the overflow
 * billed to usage credits. Bolting it onto that file would trip its
 * fail-closed streak logic on quiet days (the fleet had 10 sub-$100 days in
 * 64). Reviewed 2026-09-08: /plan-review returned FAIL on the "extend
 * provider-spend-core" design and named this separate module as its own
 * redesign #1; /second-opinion then confirmed this IS that redesign, not the
 * rejected work renamed. Both verdicts in .claude/review-verdicts.jsonl.
 *
 * All functions here are pure and take data in. The filesystem walk lives in
 * scripts/forecast-claude-spend.js so these stay testable (CLAUDE.md rule 15).
 */

const { APPROX_MODEL_RATES_PER_MTOK } = require('./claude-cli');

/**
 * $/1M tokens. The opus/sonnet/haiku rows are IMPORTED from claude-cli.js
 * rather than redeclared — a second-opinion design blocker (2026-09-08): three
 * copies of the same rates means one of them silently goes stale. Only the
 * fable row is added here, because no public list price exists for it; it is
 * priced at the Sonnet tier as a labelled assumption (fable was 0.3-8% of
 * measured spend, so the assumption cannot move a forecast materially).
 */
const PRICES = Object.freeze({ ...APPROX_MODEL_RATES_PER_MTOK, fable: { in: 3, out: 15 } });
const ASSUMED_PRICE_TIERS = Object.freeze(['fable']);
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** Map a raw model id to a price tier, or null if we refuse to guess. */
function modelTier(model) {
  if (!model || typeof model !== 'string') return null;
  const m = model.toLowerCase();
  return Object.keys(PRICES).find((k) => m.includes(k)) || null;
}

/**
 * List-price cost of one assistant message's usage object.
 *
 * NOTE: this deliberately returns { usd: 0, tier: null } for an unrecognised
 * model, where claude-cli.js's estimateCostUSD() defaults such models to the
 * sonnet tier. That default is right for its job — a spend circuit breaker
 * must see ~$2 rather than $0 for a killed session. It is wrong for this one:
 * a forecast that silently priced a renamed Opus model at Sonnet rates would
 * understate demand 5x and still read as confidently correct. Do NOT "fix"
 * this back to matching; count the unpriced messages instead (the CLI does).
 */
function priceUsage(usage, model) {
  const tier = modelTier(model);
  if (!tier || !usage) return { usd: 0, tier: null };
  const p = PRICES[tier];
  const inTok =
    (usage.input_tokens || 0) +
    CACHE_WRITE_MULTIPLIER * (usage.cache_creation_input_tokens || 0) +
    CACHE_READ_MULTIPLIER * (usage.cache_read_input_tokens || 0);
  return { usd: (inTok * p.in + (usage.output_tokens || 0) * p.out) / 1e6, tier };
}

/** Group { 'YYYY-MM-DD': usd } into weeks anchored on the plan's reset day (Thu). */
function weeklyBuckets(byDay, anchorDow = 4) {
  const out = {};
  for (const [day, usd] of Object.entries(byDay || {})) {
    const t = Date.parse(day + 'T00:00:00Z');
    if (Number.isNaN(t)) continue;
    const back = (new Date(t).getUTCDay() - anchorDow + 7) % 7;
    const wk = new Date(t - back * 864e5).toISOString().slice(0, 10);
    out[wk] = (out[wk] || 0) + usd;
  }
  return out;
}

function quantile(arr, p) {
  if (!arr || !arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/**
 * Derive the weekly plan allowance from weeks where BOTH demand and the amount
 * actually billed to usage credits are known: billed = max(0, demand - allowance).
 * boostFactor divides back to the un-boosted baseline (1.5 during a +50% boost).
 *
 * confidence is 'provisional' below n=3 — a single atypical calibration week
 * would set the allowance wrong for every later forecast, so callers MUST
 * surface the flag rather than present the number as solid (second-opinion
 * warning C). It does not refuse at n=1, because n=1 is all that exists at
 * first use.
 */
function calibrateAllowance(samples, boostFactor = 1) {
  const list = Array.isArray(samples) ? samples : [samples];
  const valid = list.filter((s) => s && Number.isFinite(s.demandWeek) && Number.isFinite(s.billedWeek));
  if (!valid.length) return null;
  const boosted = valid.reduce((sum, s) => sum + (s.demandWeek - s.billedWeek), 0) / valid.length;
  return {
    boostedWeekly: boosted,
    baseWeekly: boosted / boostFactor,
    n: valid.length,
    confidence: valid.length >= 3 ? 'calibrated' : 'provisional',
  };
}

/**
 * Forecast the monthly bill as a DISTRIBUTION over historical weeks.
 * Demand is bursty (top 5 of 64 days carried 25% of it), so the mean is
 * misleading — median is the honest central estimate and is reported first.
 * monthlyCap clamps the result, because a provider spend limit turns an
 * unbounded money risk into a bounded work-stoppage risk.
 */
function forecastMonthly({ weeklyDemands, baseWeekly, monthlyCap = Infinity, weeksPerMonth = 4.33 }) {
  const demands = (weeklyDemands || []).filter(Number.isFinite);
  const bills = demands.map((d) => Math.max(0, d - baseWeekly));
  const cap = (v) => Math.min(monthlyCap, v * weeksPerMonth);
  const p75 = quantile(bills, 0.75);
  return {
    weeks: demands.length,
    overflowWeeks: bills.filter((b) => b > 0).length,
    weeklyBill: { p25: quantile(bills, 0.25), median: quantile(bills, 0.5), p75 },
    monthly: { p25: cap(quantile(bills, 0.25)), median: cap(quantile(bills, 0.5)), p75: cap(p75) },
    capBindsAtP75: p75 * weeksPerMonth > monthlyCap,
    weeksToExhaustCapAtP75: p75 > 0 ? monthlyCap / p75 : Infinity,
  };
}

module.exports = {
  PRICES,
  ASSUMED_PRICE_TIERS,
  CACHE_WRITE_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  modelTier,
  priceUsage,
  weeklyBuckets,
  quantile,
  calibrateAllowance,
  forecastMonthly,
};
