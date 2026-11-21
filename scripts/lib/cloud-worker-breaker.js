/**
 * cloud-worker-breaker — spend breaker for the cloud board worker (BRO-6229, Mac-to-cloud Phase 1).
 *
 * WHY: the Mac's dispatch-ledger guards (spend breaker, per-card retry limit) live in a file on
 * the Mac, so they never applied to scripts/cloud-worker-pick.js (lib/cloud-worker-pick.js
 * header). Phase 4 moves the dispatch fleet to the cloud only after a breaker whose STATE LIVES
 * OFF THE MAC has run a week. The state here is Linear itself: every board-worker claim posts
 * "Claimed by <session> ... Worker model: sonnet|opus" (linear-session.js claim --worker-model),
 * so the claims are the attempt log. Nothing is written anywhere.
 *
 * Two caps:
 *   - DAILY: Claude-lane claims across the board in the last 24h. The routine's own ceiling is
 *     12 firings x 4 claims = 48 a day (board-workers.md), and it runs close to that (42 measured
 *     2026-10-25, after BRO-6087 pushed firings toward 4 claims). A rolling 24h window can hold
 *     claims from 13 firings (one that started just before the window), so 52 is still the
 *     design; DEFAULT_DAILY_CAP sits past it. A count there means something outside the routine
 *     is spending: an extra routine, manual triggers, or a worker ignoring the per-firing cap.
 *     A first test run with a cap of 40 tripped on normal operation (BRO-6231, cancelled).
 *   - PER CARD: Claude-lane claims on one card in the last CARD_WINDOW_MS (7 days, so a card
 *     comes back once its old attempts age out). A card that keeps getting claimed and not
 *     closed (paused with a bot "answer", blocked, reclaimed) burns a session each time;
 *     MAX_PAUSES only counts pauses. A card-cap skip is quiet (stderr and the pick JSON); only
 *     the daily cap alerts the owner.
 * Only claims with a sonnet/opus "Worker model:" line count, the same rule as
 * worker-firing-stats.js: a session's own `linear-brain.js create --self` claim has no model line
 * and Codex claims are a separate lane with its own budget.
 *
 * ADVISORY FIRST (CLAUDE.md rule 19): the default mode only reports what it would skip
 * (`wouldSkip`); CLOUD_WORKER_BREAKER_ENFORCE=true makes it skip. CLOUD_WORKER_BREAKER_DISABLED=true
 * turns it off entirely (no reads, no alert). P0 (Linear priority 1) is never skipped in any
 * mode: a trip must never block an opening-night card. A failed read fails open.
 *
 * The per-card count also fails open when a card's comments were not prefetched: the picker's
 * late read is capped at 50 comments, and past its history-check budget it takes cards unchecked.
 *
 * NOT metered: resumes of a refused landing (their claim is a no-op and posts nothing) and the
 * Codex --list path.
 */

'use strict';

const { parseWorkerModel } = require('./linear-session-reporting.js');

const DAY_MS = 24 * 3600_000;
const CARD_WINDOW_MS = 7 * DAY_MS;
const DEFAULT_DAILY_CAP = 56;
const DEFAULT_CARD_ATTEMPT_CAP = 4;
const CLAUDE_LANE_MODELS = ['sonnet', 'opus'];
const CONDITION_KEY = 'cloud-worker-breaker-daily-cap';
const CLAIM_LINE_RE = /^Claimed by /;

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** PURE. -> { mode: 'off'|'advisory'|'enforce', dailyCap, cardAttemptCap } from the environment. */
function breakerConfig(env = process.env) {
  const mode = env.CLOUD_WORKER_BREAKER_DISABLED === 'true' ? 'off'
    : env.CLOUD_WORKER_BREAKER_ENFORCE === 'true' ? 'enforce' : 'advisory';
  return {
    mode,
    dailyCap: positiveInt(env.CLOUD_WORKER_DAILY_CAP, DEFAULT_DAILY_CAP),
    cardAttemptCap: positiveInt(env.CLOUD_WORKER_CARD_ATTEMPT_CAP, DEFAULT_CARD_ATTEMPT_CAP),
  };
}

/** PURE. True for a board-worker (Claude lane) claim comment body. */
function isClaudeLaneClaim(body) {
  const text = String(body || '');
  return CLAIM_LINE_RE.test(text) && CLAUDE_LANE_MODELS.includes(parseWorkerModel(text));
}

/**
 * PURE. Claude-lane claims created in the 24h before nowMs. comments: [{ id?, body, createdAt }];
 * a comment fetched by two queries (a body with two model lines) counts once.
 */
function countDailyClaims(comments, nowMs) {
  const seen = new Set();
  let n = 0;
  for (const c of Array.isArray(comments) ? comments : []) {
    const t = Date.parse(c && c.createdAt);
    if (!isClaudeLaneClaim(c && c.body) || !Number.isFinite(t) || t > nowMs || nowMs - t >= DAY_MS) continue;
    const key = c.id || `${c.createdAt}|${c.issue && c.issue.identifier}|${c.body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    n++;
  }
  return n;
}

/** PURE. Claude-lane claims among one card's comment nodes in the CARD_WINDOW_MS before nowMs. */
function cardAttempts(nodes, nowMs) {
  return (Array.isArray(nodes) ? nodes : []).filter((c) => {
    const t = Date.parse(c && c.createdAt);
    return isClaudeLaneClaim(c && c.body) && Number.isFinite(t) && t <= nowMs && nowMs - t < CARD_WINDOW_MS;
  }).length;
}

/**
 * PURE. The breaker's verdict on taking one card.
 * @param {{ issue: object, dailyClaims: number|null, cardAttempts: number, config: object }} p
 *   dailyClaims null = the read failed (fails open: no daily trip).
 * @returns {{ skip: boolean, wouldSkip: string|null, reason: string|null }}
 *   reason 'breaker-daily-cap' | 'breaker-card-attempts' | null; skip only in enforce mode,
 *   wouldSkip carries the same reason in advisory mode.
 */
function breakerDecision({ issue, dailyClaims, cardAttempts: attempts, config }) {
  const none = { skip: false, wouldSkip: null, reason: null };
  if (!config || config.mode === 'off') return none;
  if (Number(issue && issue.priority) === 1) return none; // P0: never blocked
  let reason = null;
  if (Number.isFinite(dailyClaims) && dailyClaims >= config.dailyCap) reason = 'breaker-daily-cap';
  else if (Number(attempts) >= config.cardAttemptCap) reason = 'breaker-card-attempts';
  if (!reason) return none;
  return config.mode === 'enforce'
    ? { skip: true, wouldSkip: null, reason }
    : { skip: false, wouldSkip: reason, reason };
}

/** PURE. True when the daily cap is reached (the condition the owner is alerted about). */
function dailyCapReached(dailyClaims, config) {
  return !!config && config.mode !== 'off' && Number.isFinite(dailyClaims) && dailyClaims >= config.dailyCap;
}

/**
 * PURE. routeAlert() options for a daily-cap trip. 'auto' files one Linear card, deduped on the
 * conditionKey by the router's Linear search, so it holds from an ephemeral cloud container.
 * VERIFY: owner-judgment because the call (raise the cap, find the runaway, flip enforce) is the
 * owner's, and the router's default ledger check would pass vacuously off the container.
 */
function tripAlert({ dailyClaims, config }) {
  const enforce = config.mode === 'enforce';
  return {
    conditionKey: CONDITION_KEY,
    disposition: 'auto',
    severity: 'warning', // the router derives the card's Linear priority (Medium) from this
    title: enforce
      ? `Cloud worker spend breaker tripped: ${dailyClaims} worker sessions in 24h (cap ${config.dailyCap})`
      : `Cloud worker spend breaker would have tripped: ${dailyClaims} worker sessions in 24h (cap ${config.dailyCap}, advisory)`,
    description: [
      `The cloud board worker claimed ${dailyClaims} cards in the last 24 hours; the breaker cap is ${config.dailyCap} (the routine's own ceiling is 48 a day, 52 in a rolling window).`,
      enforce
        ? 'The worker now takes only P0 cards until the 24h count drops under the cap.'
        : 'Advisory mode: nothing was skipped. This shows where the cap would bite before it is enforced.',
      'Options: find what is spending past the routine (an extra routine, manual triggers), raise CLOUD_WORKER_DAILY_CAP, or set CLOUD_WORKER_BREAKER_ENFORCE / CLOUD_WORKER_BREAKER_DISABLED.',
      // BRO-5371: only an enforced trip is an owner call (money); the line below is what emails them. The advisory
      // trip is information, so it carries no marker and falls back to the router's condition-absent check.
      ...(enforce ? [
        `DECISION NEEDED: The automatic card worker has used ${dailyClaims} sessions in 24 hours, over its limit of ${config.dailyCap}, so it now only takes the most urgent cards. Should it keep that limit, or be allowed more?`,
        `Option A: Keep the limit. Spending stays capped, and non-urgent cards wait until the count drops.`,
        `Option B: Raise the limit. Cards keep moving, and the extra sessions cost more.`,
        `My recommendation: Option A, unless the board has urgent work waiting, because nothing else is bounding this spend.`,
        `Default: the limit stays, and the worker keeps taking only urgent cards.`,
      ] : []),
      'Source: scripts/lib/cloud-worker-breaker.js (BRO-6229).',
    ].join('\n'),
    ...(enforce ? { verify: { line: 'VERIFY: owner-judgment', note: 'Owner call: raise the cap, stop the extra spend, or turn the breaker off.' } } : {}),
  };
}

module.exports = {
  DAY_MS, CARD_WINDOW_MS, DEFAULT_DAILY_CAP, DEFAULT_CARD_ATTEMPT_CAP, CONDITION_KEY, CLAUDE_LANE_MODELS,
  breakerConfig, isClaudeLaneClaim, countDailyClaims, cardAttempts, breakerDecision, dailyCapReached, tripAlert,
};
