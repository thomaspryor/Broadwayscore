/**
 * autonomous-budget.js — pure budget accounting for the autonomous nightly
 * loop (Sprint 2, Notion 39b637c5).
 *
 * Admission model (reservation, not estimation): admitting a card RESERVES
 * its worst case — attempt 1 plus the possible attempt-2 escalation —
 * against the night's remaining budget. Otherwise N admitted cards can
 * collectively overshoot the cap when several need their retry. When a card
 * finishes, settle() refunds the unspent reservation (in particular the
 * whole attempt-2 slice when attempt 1 lands — Sprint-2 carry-forward #3),
 * so later queue items regain headroom.
 *
 * Model policy: attempt 1 is always Sonnet. Attempt 2 escalates to Opus
 * ONLY on a content failure (checks failed, wrong diff); infra failures
 * (rebase, network, timeout) retry on Sonnet — a flaky rebase must never
 * buy a 5x-cost model. Fable/Mythos-tier models are HARD-EXCLUDED: the
 * loop runs unattended and must never pick the priciest tier by accident.
 *
 * The night cap is also sanity-checked against the shared Anthropic daily
 * cap from opening-night-budget.js — the loop shares that spend pool with
 * opening-night automation.
 */

'use strict';

const { DEFAULT_CAPS } = require('./opening-night-budget.js');

// Per-card envelopes. maxUSD/maxWallMin are hard per-attempt kill limits the
// executor enforces cooperatively; estUSD/estAttempt2USD drive admission.
//
// L (Sprint 3, S3-T4): "incremental — never admitted whole" means never
// admitted as ONE worst-case-2-attempts reservation like S/M. estAttempt2USD
// is 0 on purpose: an L card gets exactly one S-sized slice per night; if it
// doesn't finish, tomorrow night's slice IS the retry (a checkpoint branch,
// not a second same-night attempt) — see scripts/lib/autonomous-checkpoint.js.
const ENVELOPES = Object.freeze({
  S: Object.freeze({ maxUSD: 1.5, maxWallMin: 30, estUSD: 0.8, estAttempt2USD: 1.6 }),
  M: Object.freeze({ maxUSD: 3.0, maxWallMin: 90, estUSD: 2.5, estAttempt2USD: 5.0 }),
  L: Object.freeze({ maxUSD: 1.5, maxWallMin: 30, estUSD: 0.8, estAttempt2USD: 0, incremental: true }),
});

const DEFAULTS = Object.freeze({
  nightUSD: 5,
  weeklyUSD: null, // NEVER invented — % of budget only shows when configured
  maxItems: 3,
  reserveUSD: 0.5, // triage + morning email
  sizes: ['S'],
});

// ── Model policy ────────────────────────────────────────────────────────────

const MODELS = Object.freeze({
  attempt1: 'claude-sonnet-5',
  attempt2Content: 'claude-opus-4-8',
});

// Unattended sessions must never select the Fable/Mythos tier (or an unknown
// future alias of it). Checked on OUTPUT so a bad table edit can't leak one.
const FORBIDDEN_MODEL_RE = /fable|mythos/i;

// $/MTok (input, output) by model family — for ledgering raw-API calls
// (triage) whose responses carry token counts but no cost field. Matched by
// substring so date-suffixed ids ("claude-sonnet-5-2026…") still price.
// claude CLI calls don't need this: they report total_cost_usd directly.
const MODEL_PRICES = Object.freeze([
  Object.freeze({ re: /opus/i, inUSD: 5, outUSD: 25 }),
  Object.freeze({ re: /sonnet/i, inUSD: 3, outUSD: 15 }),
  Object.freeze({ re: /haiku/i, inUSD: 1, outUSD: 5 }),
]);

// Conservative estimate: unknown model families price at 0 (tokens are still
// ledgered, so the gap is visible) rather than guessing a tier.
function estimateUSD(model, tokensIn, tokensOut) {
  const p = MODEL_PRICES.find(x => x.re.test(String(model || '')));
  if (!p) return 0;
  const usd = ((Number(tokensIn) || 0) / 1e6) * p.inUSD + ((Number(tokensOut) || 0) / 1e6) * p.outUSD;
  return Math.round(usd * 10000) / 10000; // 4dp — triage calls are fractions of a cent
}

/**
 * @param {number} attempt - 1 or 2
 * @param {'content'|'infra'|null} [failureKind] - why attempt 1 failed
 */
function pickModel(attempt, failureKind = null) {
  let model;
  if (attempt === 1) model = MODELS.attempt1;
  else if (attempt === 2) model = failureKind === 'content' ? MODELS.attempt2Content : MODELS.attempt1;
  else throw new Error(`attempt cap is 2/night, got attempt=${attempt}`);
  if (FORBIDDEN_MODEL_RE.test(model)) {
    throw new Error(`pickModel produced a forbidden model tier: ${model}`);
  }
  return model;
}

// ── Night budget ────────────────────────────────────────────────────────────

function createNightBudget(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!Number.isFinite(cfg.nightUSD) || cfg.nightUSD <= 0) throw new Error('nightUSD must be positive');
  if (!Number.isInteger(cfg.maxItems) || cfg.maxItems <= 0) throw new Error('maxItems must be a positive integer');

  let available = round2(cfg.nightUSD - cfg.reserveUSD);
  let reserved = 0;
  let spent = 0;
  let items = 0;
  const open = new Map(); // cardId → reservedUSD

  function envelope(size) { return ENVELOPES[size] || null; }

  // Reserve worst case (both attempts) or refuse. Refusal reasons are
  // human-readable — they land on the card and in the email.
  function admit(cardId, size) {
    const env = envelope(size);
    if (!env) return { admitted: false, reason: `size "${size}" has no budget envelope (L cards are worked incrementally, never admitted whole)` };
    if (!cfg.sizes.includes(size)) return { admitted: false, reason: `size ${size} not enabled tonight (config sizes: ${cfg.sizes.join(',')})` };
    if (items >= cfg.maxItems) return { admitted: false, reason: `night item cap (${cfg.maxItems}) reached` };
    const worstCase = worstCaseUSD(env);
    if (worstCase > remaining()) {
      return { admitted: false, reason: `worst-case $${worstCase.toFixed(2)} (both attempts) exceeds remaining $${remaining().toFixed(2)}` };
    }
    reserved = round2(reserved + worstCase);
    items++;
    open.set(cardId, worstCase);
    return { admitted: true, reservedUSD: worstCase };
  }

  // Attempt 1 landed → give back the untouched attempt-2 slice immediately
  // so cards later in tonight's queue regain headroom (carry-forward #3).
  function refundAttempt2(cardId, size) {
    const env = envelope(size);
    if (!env || !open.has(cardId)) return 0;
    const cur = open.get(cardId);
    const refund = Math.min(env.estAttempt2USD, cur);
    open.set(cardId, round2(cur - refund));
    reserved = round2(reserved - refund);
    return refund;
  }

  // Card finished (pass or fail): swap the rest of its reservation for the
  // actual spend. Overruns are clamped at 0 refund — spend is still recorded.
  function settle(cardId, actualUSD) {
    const cur = open.get(cardId) || 0;
    open.delete(cardId);
    reserved = round2(reserved - cur);
    spent = round2(spent + (Number(actualUSD) || 0));
  }

  function remaining() { return round2(available - reserved - spent); }

  // Cooperative per-attempt kill check — the executor calls this while an
  // implementer runs; a true verdict aborts the card mid-flight.
  function shouldAbort(size, { elapsedMin = 0, attemptUSD = 0 } = {}) {
    const env = envelope(size);
    if (!env) return { abort: true, reason: `unknown size ${size}` };
    if (attemptUSD > env.maxUSD) return { abort: true, reason: `attempt spend $${attemptUSD.toFixed(2)} exceeded per-card cap $${env.maxUSD.toFixed(2)}` };
    if (elapsedMin > env.maxWallMin) return { abort: true, reason: `wall clock ${Math.round(elapsedMin)}min exceeded cap ${env.maxWallMin}min` };
    return { abort: false };
  }

  return {
    config: cfg,
    admit, refundAttempt2, settle, remaining, shouldAbort,
    state: () => ({ available, reserved, spent, items, remaining: remaining() }),
  };
}

// A size can be "enabled" in config yet mathematically inadmissible: its
// worst-case reservation (both attempts) exceeds even a fresh night's
// available budget (nightUSD - reserveUSD). On an M-only night that config
// silently does zero work (2026-07-15: $5 night, M worst-case $7.50 —
// 41 triage LLM calls, 0 attempts). Surface it so the run can warn loudly.
function inadmissibleSizes({ nightUSD, sizes, reserveUSD = DEFAULTS.reserveUSD } = {}) {
  const available = round2(nightUSD - reserveUSD);
  return (sizes || []).filter(size => {
    const env = ENVELOPES[size];
    if (!env || env.incremental) return false; // L is worked incrementally, never admitted whole
    return worstCaseUSD(env) > available;
  }).map(size => ({
    size,
    worstCaseUSD: worstCaseUSD(ENVELOPES[size]),
    availableUSD: available,
  }));
}

// Single source of truth for the admission reservation — admit() and
// inadmissibleSizes() must agree or the warning lies about admissibility.
function worstCaseUSD(env) { return round2(env.estUSD + env.estAttempt2USD); }

// The loop shares the Anthropic daily dollar pool with opening-night
// automation — refuse a night config that could eat the whole shared cap.
function checkSharedDailyCap(nightUSD, caps = DEFAULT_CAPS) {
  const cap = caps.anthropic.dailyDollarCap;
  if (nightUSD > cap) return { ok: false, message: `night budget $${nightUSD} exceeds the shared Anthropic daily cap $${cap}` };
  if (nightUSD > cap * 0.5) return { ok: true, warning: `night budget $${nightUSD} is >50% of the shared Anthropic daily cap $${cap}` };
  return { ok: true };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  ENVELOPES,
  DEFAULTS,
  MODELS,
  FORBIDDEN_MODEL_RE,
  MODEL_PRICES,
  estimateUSD,
  pickModel,
  createNightBudget,
  checkSharedDailyCap,
  inadmissibleSizes,
};
