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
 * Model policy: attempt 1 is Sonnet by default. Attempt 2 escalates to Opus
 * ONLY on a content failure (checks failed, wrong diff); infra failures
 * (rebase, network, timeout) retry on Sonnet — a flaky rebase must never
 * buy a 5x-cost model. Fable/Mythos-tier models are HARD-EXCLUDED: the
 * loop runs unattended and must never pick the priciest tier by accident.
 *
 * Owner override (2026-07-22, supervised live run: "I don't trust Sonnet
 * much" on an L-sized task): incremental (L) slices and Tier-2
 * data-destructive card classes (cluster-cleanup's dedup, which DELETES
 * review files it judges duplicates) run attempt 1 on Opus too, regardless
 * of failureKind — see pickModel's `hint` param. Both share the same trait:
 * there is no same-night retry to catch a bad attempt 1 (L checkpoints to
 * next night; data cards are single-attempt), and a wrong data-destructive
 * call destroys data rather than just wasting a diff — so first-pass
 * quality matters more than it does for a retryable S/M card. This is about
 * quality, not merge safety: every data-card pass still lands on
 * needs-approval for a human tap (attemptDataCard), so this never changes
 * who can merge.
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
// is 0 on purpose: an L card gets exactly one slice per night; if it
// doesn't finish, tomorrow night's slice IS the retry (a checkpoint branch,
// not a second same-night attempt) — see scripts/lib/autonomous-checkpoint.js.
// Owner raise 2026-07-22: previous caps starved the loop — a real S card
// (High Society, Sonnet, 4.4M tokens in) cost $2.35 against a $1.50 cap and
// was killed AFTER doing the work. Caps now sized so a normal attempt fits
// with headroom; sustained spend is bounded by weeklyUSD, not per-card caps.
// Same-day follow-up: L's single slice now runs on Opus (pickModel's
// incremental hint, below) — an S-sized $2 estimate would get killed by
// shouldAbort mid-flight on Opus's ~5x token cost, so the slice is resized
// to an M-shaped envelope ($10 max / $5 est) while keeping the 45min wall
// clock (Opus is pricier per token, not slower to respond).
const ENVELOPES = Object.freeze({
  S: Object.freeze({ maxUSD: 4, maxWallMin: 45, estUSD: 2, estAttempt2USD: 4 }),
  // M raised 10/4/8 → 14/6/10 (2026-07-25, ship-check QA): tier-3 M cards run
  // attempt 1 on FORCED Opus, and the old Sonnet-sized cap is the documented
  // cap-kill mode ("$1.50 S cap killed a completed $2.35 card"). Applies to
  // all M admissions — over-reserving Tier-2 Sonnet M cards is the safe
  // direction (admits fewer cards, never kills completed work).
  M: Object.freeze({ maxUSD: 14, maxWallMin: 120, estUSD: 6, estAttempt2USD: 10 }),
  L: Object.freeze({ maxUSD: 10, maxWallMin: 45, estUSD: 5, estAttempt2USD: 0, incremental: true }),
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

// Tier-2 data-card classes whose diff can DELETE existing review data, not
// just add or repair it (autonomous-eligibility.js classifyDataCard/
// DATA_CLASS_REPO owns the enum — this is a subset of it). A wrong call here
// destroys data rather than wasting a diff, and attemptDataCard gives these
// exactly one attempt, so pickModel forces attempt 1 onto Opus for them (see
// the `hint` param below) rather than trusting the Sonnet-then-escalate path
// that only applies to retryable S/M cards.
const DATA_DESTRUCTIVE_CLASSES = new Set(['cluster-cleanup']);

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
 * @param {object} [hint] - forces attempt 1 onto Opus when set (owner
 *   2026-07-22: no same-night retry exists for these, so attempt 1 has to be
 *   the best shot, not the default floor)
 * @param {boolean} [hint.incremental] - an L-sized checkpoint slice
 * @param {string|null} [hint.dataClass] - a Tier-2 data card's classifyDataCard() class
 * @param {string|null} [hint.tier3Size] - a Tier-3 code card's triage size.
 *   M+ code cards force Opus on attempt 1 (owner 2026-07-25, same rationale as
 *   L/data-destructive: "I don't trust Sonnet much" for unattended code that
 *   can reach src/; src-vs-scripts isn't knowable before the diff exists, so
 *   size is the pre-implementation proxy). S code cards stay on the floor —
 *   a content failure still escalates attempt 2 to Opus as usual.
 */
function pickModel(attempt, failureKind = null, hint = {}) {
  const { incremental = false, dataClass = null, tier3Size = null } = hint;
  const forceOpus = incremental
    || (dataClass != null && DATA_DESTRUCTIVE_CLASSES.has(dataClass))
    || (tier3Size != null && tier3Size !== 'S');
  let model;
  if (attempt === 1) {
    model = forceOpus ? MODELS.attempt2Content : MODELS.attempt1;
  } else if (attempt === 2) {
    // An Opus-forced card must never RETRY on a weaker model than its first
    // attempt (ship-check QA: infra-failure retry used to drop tier-3 M back
    // to Sonnet). Otherwise: content failures escalate, infra retries same.
    model = (forceOpus || failureKind === 'content') ? MODELS.attempt2Content : MODELS.attempt1;
  } else {
    throw new Error(`attempt cap is 2/night, got attempt=${attempt}`);
  }
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

// Weekly spend clamp (owner 2026-07-22: "$60/night, but I doubt we can spend
// that much multiple days in a row"). Pure: given the configured night cap,
// the weekly cap (null = no weekly limit), and the ledger's trailing-7-day
// spend, returns the effective night budget. A heavy night is allowed; the
// following nights shrink until the trailing week drops back under the cap.
function clampNightToWeekly(nightUSD, weeklyUSD, spent7dUSD) {
  if (!Number.isFinite(weeklyUSD) || weeklyUSD <= 0) return { nightUSD, clamped: false };
  const weekRemaining = round2(weeklyUSD - (Number(spent7dUSD) || 0));
  if (weekRemaining >= nightUSD) return { nightUSD, clamped: false };
  return {
    nightUSD: Math.max(0, weekRemaining),
    clamped: true,
    reason: `weekly cap: $${(Number(spent7dUSD) || 0).toFixed(2)} spent in the last 7 days of $${weeklyUSD} — tonight capped at $${Math.max(0, weekRemaining).toFixed(2)} (config night cap $${nightUSD})`,
  };
}

// The loop shares the Anthropic daily dollar pool with opening-night
// automation — refuse a night config that could eat the whole shared cap.
function checkSharedDailyCap(nightUSD, caps = DEFAULT_CAPS) {
  const cap = caps.anthropic.dailyDollarCap;
  if (nightUSD > cap) return { ok: false, message: `night budget $${nightUSD} exceeds the shared Anthropic daily cap $${cap}` };
  if (nightUSD > cap * 0.5) return { ok: true, warning: `night budget $${nightUSD} is >50% of the shared Anthropic daily cap $${cap}` };
  return { ok: true };
}

// Spend circuit breaker (owner mandate 2026-07-30, task #635: "allows things
// to be re-attempted and fail and burn money"). Per-card caps already bound
// ONE card's runaway spend (shouldAbort above); this bounds the NIGHT: if
// real money has gone out and NOTHING has reached completed+verified yet,
// something is systemically broken (bad model, bad config, a corrupted
// queue) rather than one unlucky card, and burning through the rest of
// tonight's slots the same way is exactly the "burn money" failure mode the
// owner called out. Extends the existing clamp shape (pure function, same
// { halt/ok, reason } contract as checkSharedDailyCap) rather than adding a
// new mechanism.
//
// "Completed+verified" = a card whose diff passed every check (card-pass or
// auto-approve) — not final merge, which can lag behind a live run.
// `runEntries` must already be scoped to the run in question (e.g.
// ledger.entriesForRun(entries, runId)) — this function does no filtering
// of its own. Only `usd` is summed: card-fail/card-pass entries carry
// `totalUSD`, which DUPLICATES their own `implement` rows' `usd` (see
// autonomous-run.js's fail()/PASS comments) — summing raw `usd` across every
// entry already excludes that duplicate for free.
function spendCircuitBreakerStatus(runEntries, { thresholdUSD } = {}) {
  const threshold = Number.isFinite(thresholdUSD) && thresholdUSD > 0 ? thresholdUSD : Infinity;
  const spentUSD = round2((runEntries || []).reduce((s, e) => s + (Number(e && e.usd) || 0), 0));
  const completions = (runEntries || []).filter(e => e && (e.event === 'card-pass' || e.event === 'auto-approve')).length;
  const halt = spentUSD >= threshold && completions === 0;
  return {
    halt,
    spentUSD,
    completions,
    thresholdUSD: threshold,
    reason: halt
      ? `spend circuit breaker: $${spentUSD.toFixed(2)} spent tonight with zero cards completed+verified (threshold $${threshold.toFixed(2)}) — halting further attempts`
      : null,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  ENVELOPES,
  DEFAULTS,
  MODELS,
  DATA_DESTRUCTIVE_CLASSES,
  FORBIDDEN_MODEL_RE,
  MODEL_PRICES,
  estimateUSD,
  pickModel,
  createNightBudget,
  clampNightToWeekly,
  checkSharedDailyCap,
  inadmissibleSizes,
  spendCircuitBreakerStatus,
};
