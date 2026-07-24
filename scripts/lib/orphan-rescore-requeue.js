/**
 * orphan-rescore-requeue.js — pure decision function for #356 self-heal.
 *
 * scripts/verify-all-scored.js dispatches an llm-ensemble-score.yml rescore
 * when it finds includable-but-unscored reviews, unless its own 60-min
 * per-show cooldown suppresses the dispatch (marker.lastDispatch =
 * 'suppressed-cooldown'). opening-night-broadcast.yml's orphan-unscored gate
 * used to email the operator on EVERY blocked retry — broadcast retries every
 * ~2.8h via workflow_run, so a cooldown-suppressed dispatch meant repeated
 * emails until an operator manually ran the rescore command (2026-07-23,
 * trainspotting-the-musical-west-end-2026, run 30054954304 — nothing had
 * auto-retried).
 *
 * decideRequeueAction() is the state-in/action-out core: given this show's
 * prior auto-dispatch attempts, decide whether to dispatch again, wait for
 * the per-show cooldown to clear, or escalate once the attempt budget for
 * the rolling window is exhausted. The caller (scripts/dispatch-orphan-
 * rescore-requeue.js) does the actual I/O — reading the marker, calling
 * dispatchRescore(), and routing an alert through owner-alert-router.
 */

'use strict';

// Mirrors verify-all-scored.js's own per-show cooldown — no point re-dispatching
// faster than the upstream script itself would.
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 60 min
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h rolling attempt budget

/**
 * @param {Array<{at: string, ok: boolean}>} attempts - prior auto-dispatch attempts for this show (any age)
 * @param {Date} now
 * @param {{cooldownMs?: number, maxAttempts?: number, windowMs?: number}} [opts]
 * @returns {{action: 'dispatch'|'wait'|'alert', recentAttempts: Array, waitMs?: number}}
 */
function decideRequeueAction(attempts, now, opts = {}) {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;

  const nowMs = now.getTime();
  const recentAttempts = (attempts || []).filter((a) => {
    const t = new Date(a && a.at).getTime();
    return Number.isFinite(t) && nowMs - t < windowMs;
  });

  if (recentAttempts.length >= maxAttempts) {
    return { action: 'alert', recentAttempts };
  }

  const lastAttempt = recentAttempts[recentAttempts.length - 1];
  if (lastAttempt) {
    const sinceMs = nowMs - new Date(lastAttempt.at).getTime();
    if (sinceMs < cooldownMs) {
      return { action: 'wait', recentAttempts, waitMs: cooldownMs - sinceMs };
    }
  }

  return { action: 'dispatch', recentAttempts };
}

module.exports = {
  decideRequeueAction,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WINDOW_MS,
};
